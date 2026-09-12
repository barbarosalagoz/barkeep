/*
 * Typed client for the deployed Payment Tracker contract.
 *
 * Reads go through Soroban RPC simulation (no signing, no fees). Writes are
 * prepared against RPC, signed by Freighter, submitted, and then polled to
 * completion.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import { signWithWallet } from "../services/wallet";

import { AppError, classifyError } from "../errors";

/** Deployed on Stellar Testnet. See the Smart Contract section of the README. */
export const PAYMENT_TRACKER_ID =
  "CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X";

export const SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

export const EXPLORER_CONTRACT_URL = `https://stellar.expert/explorer/testnet/contract/${PAYMENT_TRACKER_ID}`;

const STROOPS_PER_XLM = 10_000_000n;

/** Inclusion fee. `prepareTransaction` adds the Soroban resource fee on top. */
const INCLUSION_FEE = String(Number(BASE_FEE) * 100);

const server = new rpc.Server(SOROBAN_RPC_URL);

export type PaymentStatus = "Pending" | "Completed" | "Cancelled";

const STATUS_BY_DISCRIMINANT: PaymentStatus[] = [
  "Pending",
  "Completed",
  "Cancelled",
];

export interface TrackedPayment {
  id: number;
  from: string;
  to: string;
  amount: bigint;
  status: PaymentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface BatchRecipient {
  destination: string;
  amount: bigint;
}

/*
 * All raw failures (simulation, signing, submission) flow through the shared
 * taxonomy in src/errors.ts, which also decodes "Error(Contract, #N)" codes
 * and maps balance failures to INSUFFICIENT_BALANCE.
 */
function describeContractError(raw: string): AppError {
  return classifyError(new Error(raw));
}

/* ------------------------------------------------------------------ */
/* Amount helpers                                                      */
/* ------------------------------------------------------------------ */

/** Parse a user-entered XLM amount into stroops. */
export function xlmToStroops(value: string): bigint {
  const trimmed = value.trim();

  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    throw new Error(
      "Enter a positive amount with up to 7 decimal places."
    );
  }

  const [whole, fraction = ""] = trimmed.split(".");
  const stroops =
    BigInt(whole) * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, "0"));

  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero.");
  }

  return stroops;
}

/** Render stroops as a trimmed XLM string. */
export function stroopsToXlm(stroops: bigint): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;

  const whole = absolute / STROOPS_PER_XLM;
  const fraction = (absolute % STROOPS_PER_XLM)
    .toString()
    .padStart(7, "0")
    .replace(/0+$/, "");

  const rendered = fraction ? `${whole}.${fraction}` : `${whole}`;

  return negative ? `-${rendered}` : rendered;
}

/* ------------------------------------------------------------------ */
/* Argument encoding                                                   */
/* ------------------------------------------------------------------ */

const addressArg = (value: string): xdr.ScVal =>
  new Address(value).toScVal();

const i128Arg = (value: bigint): xdr.ScVal =>
  nativeToScVal(value, { type: "i128" });

const u32Arg = (value: number): xdr.ScVal =>
  nativeToScVal(value, { type: "u32" });

/** Encode `Vec<(Address, i128)>` for `create_batch`. */
const recipientsArg = (recipients: BatchRecipient[]): xdr.ScVal =>
  xdr.ScVal.scvVec(
    recipients.map((recipient) =>
      xdr.ScVal.scvVec([
        addressArg(recipient.destination),
        i128Arg(recipient.amount),
      ])
    )
  );

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

function buildInvocation(
  source: Awaited<ReturnType<typeof server.getAccount>>,
  method: string,
  args: xdr.ScVal[]
) {
  return new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(new Contract(PAYMENT_TRACKER_ID).call(method, ...args))
    .setTimeout(60)
    .build();
}

/**
 * Run a read-only view through simulation.
 *
 * `sourceAddress` is only used to build a well-formed transaction envelope;
 * nothing is signed, submitted, or charged.
 */
async function simulateView<T>(
  sourceAddress: string,
  method: string,
  args: xdr.ScVal[] = []
): Promise<T> {
  const account = await server.getAccount(sourceAddress);
  const simulation = await server.simulateTransaction(
    buildInvocation(account, method, args)
  );

  if (rpc.Api.isSimulationError(simulation)) {
    throw describeContractError(simulation.error);
  }

  if (!simulation.result?.retval) {
    throw new Error(`The contract returned no value from ${method}.`);
  }

  return scValToNative(simulation.result.retval) as T;
}

export interface InvocationResult<T> {
  hash: string;
  value: T;
}

/** Progress of an in-flight write, for a live status indicator in the UI. */
export interface TxStatus {
  phase: "signing" | "pending";
  hash?: string;
}

export type TxStatusListener = (status: TxStatus) => void;

/**
 * Prepare, sign with the connected wallet, submit, and await a
 * state-changing call. `onStatus` fires as the transaction advances so the
 * UI can show signing / pending states with the hash.
 */
async function invoke<T>(
  sourceAddress: string,
  method: string,
  args: xdr.ScVal[],
  onStatus?: TxStatusListener
): Promise<InvocationResult<T>> {
  const account = await server.getAccount(sourceAddress);

  /*
   * `prepareTransaction` simulates the call, attaches the resulting
   * authorization entries and Soroban resource footprint, and raises the fee
   * to cover them.
   */
  let prepared;

  try {
    prepared = await server.prepareTransaction(
      buildInvocation(account, method, args)
    );
  } catch (error) {
    throw classifyError(error);
  }

  /*
   * Sign with whichever wallet the kit has connected (Freighter or
   * Albedo). A decline surfaces as a typed USER_REJECTED error.
   */
  onStatus?.({ phase: "signing" });

  const signedXdr = await signWithWallet(
    prepared.toEnvelope().toXdr("base64"),
    sourceAddress
  );

  const sent = await server.sendTransaction(
    TransactionBuilder.fromXdr(signedXdr, Networks.TESTNET)
  );

  if (sent.status === "ERROR") {
    throw new Error("Stellar rejected the transaction.");
  }

  onStatus?.({ phase: "pending", hash: sent.hash });

  const confirmed = await waitForTransaction(sent.hash);

  return {
    hash: sent.hash,
    value: (confirmed.returnValue
      ? scValToNative(confirmed.returnValue)
      : null) as T,
  };
}

/** Poll RPC until the transaction leaves the NOT_FOUND state. */
async function waitForTransaction(hash: string) {
  const deadline = Date.now() + 45_000;

  for (;;) {
    const result = await server.getTransaction(hash);

    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return result;
    }

    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error(
        `The transaction failed on-chain (${hash.slice(0, 8)}...).`
      );
    }

    if (Date.now() > deadline) {
      throw new Error(
        "Timed out waiting for confirmation. Check the explorer for the final status."
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

interface RawPayment {
  id: number;
  from: string;
  to: string;
  amount: bigint;
  status: number | string;
  created_at: bigint | number;
  updated_at: bigint | number;
}

function toTrackedPayment(raw: RawPayment): TrackedPayment {
  /*
   * A unit enum decodes to its discriminant. Accept a string too, so the UI
   * keeps working if the encoding ever changes.
   */
  const status =
    typeof raw.status === "number"
      ? STATUS_BY_DISCRIMINANT[raw.status] ?? "Pending"
      : (raw.status as PaymentStatus);

  return {
    id: Number(raw.id),
    from: raw.from,
    to: raw.to,
    amount: BigInt(raw.amount),
    status,
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Escrow a single payment. Returns the new payment id. */
export async function createPayment(
  sender: string,
  destination: string,
  amount: bigint,
  onStatus?: TxStatusListener
): Promise<InvocationResult<number>> {
  const result = await invoke<number>(
    sender,
    "create_payment",
    [addressArg(sender), addressArg(destination), i128Arg(amount)],
    onStatus
  );

  return { hash: result.hash, value: Number(result.value) };
}

/** Escrow one payment per recipient in a single invocation. */
export async function createBatch(
  sender: string,
  recipients: BatchRecipient[],
  onStatus?: TxStatusListener
): Promise<InvocationResult<number[]>> {
  const result = await invoke<Array<number | bigint>>(
    sender,
    "create_batch",
    [addressArg(sender), recipientsArg(recipients)],
    onStatus
  );

  return {
    hash: result.hash,
    value: (result.value ?? []).map(Number),
  };
}

/** Release an escrowed payment to its recipient. */
export function completePayment(
  sender: string,
  id: number,
  onStatus?: TxStatusListener
): Promise<InvocationResult<null>> {
  return invoke<null>(sender, "complete_payment", [u32Arg(id)], onStatus);
}

/** Refund an escrowed payment to its sender. */
export function cancelPayment(
  sender: string,
  id: number,
  onStatus?: TxStatusListener
): Promise<InvocationResult<null>> {
  return invoke<null>(sender, "cancel_payment", [u32Arg(id)], onStatus);
}

/** Fetch a single payment. */
export async function getPayment(
  viewer: string,
  id: number
): Promise<TrackedPayment> {
  return toTrackedPayment(
    await simulateView<RawPayment>(viewer, "get_payment", [u32Arg(id)])
  );
}

/** Total number of payments the contract has ever created. */
export async function getPaymentCount(viewer: string): Promise<number> {
  return Number(await simulateView<number | bigint>(viewer, "get_payment_count"));
}

/** Ids of payments sent by an address. */
export async function getSentIds(
  viewer: string,
  address: string
): Promise<number[]> {
  const ids = await simulateView<Array<number | bigint>>(viewer, "get_sent_ids", [
    addressArg(address),
  ]);

  return (ids ?? []).map(Number);
}

/** Ids of payments received by an address. */
export async function getReceivedIds(
  viewer: string,
  address: string
): Promise<number[]> {
  const ids = await simulateView<Array<number | bigint>>(
    viewer,
    "get_received_ids",
    [addressArg(address)]
  );

  return (ids ?? []).map(Number);
}

/**
 * Load the full payment records an address has sent, newest first.
 */
export async function getSentPayments(
  viewer: string,
  address: string
): Promise<TrackedPayment[]> {
  const ids = await getSentIds(viewer, address);

  const payments = await Promise.all(
    ids.map((id) => getPayment(viewer, id))
  );

  return payments.sort((a, b) => b.id - a.id);
}

/* ------------------------------------------------------------------ */
/* Contract events                                                     */
/* ------------------------------------------------------------------ */

export type ContractEventKind =
  | "payment_created"
  | "payment_completed"
  | "payment_cancelled"
  | "tracker_initialized";

/** A decoded contract event, newest-first in feeds. */
export interface ContractEventItem {
  id: string;
  kind: ContractEventKind;
  txHash: string;
  ledger: number;
  closedAt: string;
  paymentId?: number;
  amount?: bigint;
  from?: string;
  to?: string;
}

/** How far back to scan for events (~2 hours of ledgers at ~5s each). */
const EVENT_LOOKBACK_LEDGERS = 1_500;

/**
 * Fetch this contract's recent events straight from Soroban RPC.
 *
 * These are the typed #[contractevent]s the contract emits on
 * create / complete / cancel, which is what lets the UI reflect on-chain
 * activity without a backend.
 */
export async function fetchContractEvents(
  limit = 10
): Promise<ContractEventItem[]> {
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - EVENT_LOOKBACK_LEDGERS);

  const response = await server.getEvents({
    startLedger,
    filters: [{ type: "contract", contractIds: [PAYMENT_TRACKER_ID] }],
    limit: 100,
  });

  const items: ContractEventItem[] = [];

  for (const event of response.events) {
    if (!event.topic.length) {
      continue;
    }

    let kind: unknown;

    try {
      kind = scValToNative(event.topic[0]);
    } catch {
      continue;
    }

    if (
      kind !== "payment_created" &&
      kind !== "payment_completed" &&
      kind !== "payment_cancelled" &&
      kind !== "tracker_initialized"
    ) {
      continue;
    }

    const item: ContractEventItem = {
      id: event.id,
      kind,
      txHash: event.txHash,
      ledger: event.ledger,
      closedAt: event.ledgerClosedAt,
    };

    try {
      const data = scValToNative(event.value) as Record<string, unknown>;

      if (data && typeof data === "object") {
        if (data.id !== undefined) item.paymentId = Number(data.id);
        if (data.amount !== undefined) item.amount = BigInt(data.amount as bigint);
      }

      // from / to are topics 1 and 2 on payment events.
      if (event.topic.length >= 3) {
        item.from = String(scValToNative(event.topic[1]));
        item.to = String(scValToNative(event.topic[2]));
      }
    } catch {
      // Leave the event with just its kind and hash if decoding fails.
    }

    items.push(item);
  }

  return items.reverse().slice(0, limit);
}
