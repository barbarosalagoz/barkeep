/*
 * SEP-6: programmatic deposit and withdrawal.
 *
 * Deposit  (fiat -> asset): GET /deposit or /deposit-exchange returns bank
 *   instructions (IBAN + reference). The user pays, the anchor sends the asset
 *   on Stellar, and GET /transaction walks the status to "completed".
 * Withdraw (asset -> fiat): GET /withdraw or /withdraw-exchange returns the
 *   anchor's Stellar account + memo. The user sends the asset there with that
 *   memo, and GET /transaction walks the status to "completed".
 *
 * All endpoints except /info need the SEP-10 bearer token.
 */

import { ANCHOR_SANDBOX } from "../../config/stellar";

import { AnchorError } from "./errors";
import { anchorFetch, joinUrl } from "./http";
import type { AnchorConfig } from "./sep1";
import { fiatAssetId } from "./sep38";
import type { QuoteFee } from "./sep38";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Sep6Status =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_user_transfer_complete"
  | "pending_external"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "pending_user"
  | "completed"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large"
  | "error";

export type Sep6Kind =
  | "deposit"
  | "deposit-exchange"
  | "withdrawal"
  | "withdrawal-exchange";

export type MemoType = "id" | "text" | "hash";

export interface Instruction {
  value: string;
  description?: string;
}

export interface Sep6Transaction {
  id: string;
  kind: Sep6Kind;
  status: Sep6Status;
  statusEta?: number;
  moreInfoUrl?: string;
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  amountIn?: string;
  amountInAsset?: string;
  amountOut?: string;
  amountOutAsset?: string;
  amountFee?: string;
  amountFeeAsset?: string;
  feeDetails?: QuoteFee;
  quoteId?: string;
  from?: string;
  to?: string;
  stellarTransactionId?: string;
  externalTransactionId?: string;
  claimableBalanceId?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: MemoType;
  refunded?: boolean;
  /** Bank instructions (SEP-9 field names), present on deposits. */
  instructions?: Record<string, Instruction>;
}

export interface DepositInstructions {
  id: string;
  /** Free-text instructions from the anchor. */
  how?: string;
  bankName?: string;
  /** IBAN / account number to send fiat to. */
  iban?: string;
  /** Reference to put in the transfer description; routes the money. */
  reference?: string;
  instructions: Record<string, Instruction>;
  eta?: number;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  extraInfo?: Record<string, unknown>;
  moreInfoUrl?: string;
}

export interface WithdrawInstructions {
  id: string;
  /** The anchor's Stellar account to send the asset to. */
  anchorAccount: string;
  memo?: string;
  memoType?: MemoType;
  eta?: number;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  extraInfo?: Record<string, unknown>;
  moreInfoUrl?: string;
}

export interface Sep6AssetInfo {
  enabled: boolean;
  authenticationRequired?: boolean;
  minAmount?: number;
  maxAmount?: number;
  feeFixed?: number;
  feePercent?: number;
  fundingMethods?: string[];
}

export interface Sep6Info {
  deposit: Record<string, Sep6AssetInfo>;
  depositExchange: Record<string, Sep6AssetInfo>;
  withdraw: Record<string, Sep6AssetInfo>;
  withdrawExchange: Record<string, Sep6AssetInfo>;
  features: { accountCreation?: boolean; claimableBalances?: boolean };
}

export const TERMINAL_STATUSES: ReadonlySet<Sep6Status> = new Set<Sep6Status>([
  "completed",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
  "error",
]);

export const isTerminalStatus = (status: Sep6Status): boolean =>
  TERMINAL_STATUSES.has(status);

/** Human labels for the status timeline in the UI. */
export const STATUS_LABELS: Record<Sep6Status, string> = {
  incomplete: "Incomplete",
  pending_user_transfer_start: "Waiting for your transfer",
  pending_user_transfer_complete: "Transfer received, finalizing",
  pending_external: "Processing at the bank",
  pending_anchor: "Anchor processing",
  pending_stellar: "Settling on Stellar",
  pending_trust: "Waiting for a trustline",
  pending_user: "Action needed",
  completed: "Completed",
  refunded: "Refunded",
  expired: "Expired",
  no_market: "No market",
  too_small: "Amount too small",
  too_large: "Amount too large",
  error: "Failed",
};

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

const optString = (value: unknown): string | undefined =>
  value === undefined || value === null
    ? undefined
    : typeof value === "string"
      ? value
      : String(value);

const optNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

function parseInstructions(
  value: unknown
): Record<string, Instruction> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, Instruction> = {};

  for (const [key, entry] of Object.entries(value as Raw)) {
    if (entry && typeof entry === "object") {
      const item = entry as Raw;

      if (item.value !== undefined) {
        result[key] = {
          value: String(item.value),
          description: optString(item.description),
        };
      }
    } else if (typeof entry === "string") {
      result[key] = { value: entry };
    }
  }

  return result;
}

function parseMemoType(value: unknown): MemoType | undefined {
  return value === "id" || value === "text" || value === "hash"
    ? value
    : undefined;
}

export function parseTransaction(raw: Raw): Sep6Transaction {
  const id = optString(raw.id);
  const status = optString(raw.status);

  if (!id || !status) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      "The anchor returned a transaction without id or status."
    );
  }

  const feeDetails =
    raw.fee_details && typeof raw.fee_details === "object"
      ? (raw.fee_details as Raw)
      : undefined;

  return {
    id,
    kind: (optString(raw.kind) ?? "deposit") as Sep6Kind,
    status: status as Sep6Status,
    statusEta: optNumber(raw.status_eta),
    moreInfoUrl: optString(raw.more_info_url),
    message: optString(raw.message),
    startedAt: optString(raw.started_at),
    updatedAt: optString(raw.updated_at),
    completedAt: optString(raw.completed_at),
    amountIn: optString(raw.amount_in),
    amountInAsset: optString(raw.amount_in_asset),
    amountOut: optString(raw.amount_out),
    amountOutAsset: optString(raw.amount_out_asset),
    amountFee: optString(raw.amount_fee),
    amountFeeAsset: optString(raw.amount_fee_asset),
    feeDetails: feeDetails
      ? {
          total: optString(feeDetails.total) ?? "",
          asset: optString(feeDetails.asset) ?? "",
          details: Array.isArray(feeDetails.details)
            ? (feeDetails.details as Raw[]).map((detail) => ({
                name: optString(detail.name) ?? "",
                description: optString(detail.description),
                amount: optString(detail.amount) ?? "",
              }))
            : undefined,
        }
      : undefined,
    quoteId: optString(raw.quote_id),
    from: optString(raw.from),
    to: optString(raw.to),
    stellarTransactionId: optString(raw.stellar_transaction_id),
    externalTransactionId: optString(raw.external_transaction_id),
    claimableBalanceId: optString(raw.claimable_balance_id),
    withdrawAnchorAccount: optString(raw.withdraw_anchor_account),
    withdrawMemo: optString(raw.withdraw_memo),
    withdrawMemoType: parseMemoType(raw.withdraw_memo_type),
    refunded: typeof raw.refunded === "boolean" ? raw.refunded : undefined,
    instructions: raw.instructions
      ? parseInstructions(raw.instructions)
      : undefined,
  };
}

export function parseDepositResponse(raw: Raw): DepositInstructions {
  const id = optString(raw.id);

  if (!id) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      "The anchor opened a deposit without returning a transaction id."
    );
  }

  const instructions = parseInstructions(raw.instructions);

  return {
    id,
    how: optString(raw.how),
    bankName: instructions.bank_name?.value,
    iban: instructions.bank_account_number?.value,
    reference: instructions.external_transfer_memo?.value,
    instructions,
    eta: optNumber(raw.eta),
    minAmount: optNumber(raw.min_amount),
    maxAmount: optNumber(raw.max_amount),
    feeFixed: optNumber(raw.fee_fixed),
    feePercent: optNumber(raw.fee_percent),
    extraInfo:
      raw.extra_info && typeof raw.extra_info === "object"
        ? (raw.extra_info as Record<string, unknown>)
        : undefined,
    moreInfoUrl: optString(raw.more_info_url),
  };
}

export function parseWithdrawResponse(raw: Raw): WithdrawInstructions {
  const id = optString(raw.id);
  const anchorAccount = optString(raw.account_id);

  if (!id || !anchorAccount) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      "The anchor opened a withdrawal without an id or account_id."
    );
  }

  /*
   * SEP-6 uses `memo` + `memo_type`; the mock's docs mention `memo_id`, so
   * accept both.
   */
  const memo = optString(raw.memo) ?? optString(raw.memo_id);

  return {
    id,
    anchorAccount,
    memo,
    memoType: parseMemoType(raw.memo_type) ?? (memo ? "id" : undefined),
    eta: optNumber(raw.eta),
    minAmount: optNumber(raw.min_amount),
    maxAmount: optNumber(raw.max_amount),
    feeFixed: optNumber(raw.fee_fixed),
    feePercent: optNumber(raw.fee_percent),
    extraInfo:
      raw.extra_info && typeof raw.extra_info === "object"
        ? (raw.extra_info as Record<string, unknown>)
        : undefined,
    moreInfoUrl: optString(raw.more_info_url),
  };
}

function parseAssetInfoMap(value: unknown): Record<string, Sep6AssetInfo> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const result: Record<string, Sep6AssetInfo> = {};

  for (const [code, entry] of Object.entries(value as Raw)) {
    if (entry && typeof entry === "object") {
      const item = entry as Raw;

      result[code] = {
        enabled: item.enabled === true,
        authenticationRequired:
          typeof item.authentication_required === "boolean"
            ? item.authentication_required
            : undefined,
        minAmount: optNumber(item.min_amount),
        maxAmount: optNumber(item.max_amount),
        feeFixed: optNumber(item.fee_fixed),
        feePercent: optNumber(item.fee_percent),
        fundingMethods: Array.isArray(item.funding_methods)
          ? (item.funding_methods as unknown[]).map(String)
          : undefined,
      };
    }
  }

  return result;
}

export function parseInfo(raw: Raw): Sep6Info {
  const features =
    raw.features && typeof raw.features === "object"
      ? (raw.features as Raw)
      : {};

  return {
    deposit: parseAssetInfoMap(raw.deposit),
    depositExchange: parseAssetInfoMap(raw["deposit-exchange"]),
    withdraw: parseAssetInfoMap(raw.withdraw),
    withdrawExchange: parseAssetInfoMap(raw["withdraw-exchange"]),
    features: {
      accountCreation:
        typeof features.account_creation === "boolean"
          ? features.account_creation
          : undefined,
      claimableBalances:
        typeof features.claimable_balances === "boolean"
          ? features.claimable_balances
          : undefined,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Endpoints                                                           */
/* ------------------------------------------------------------------ */

/** GET /info: capabilities and limits. Public. */
export function getInfo(anchor: AnchorConfig): Promise<Sep6Info> {
  return anchorFetch<Raw>(joinUrl(anchor.transferServer, "info")).then(parseInfo);
}

export interface DepositRequest {
  /** Stellar account that receives the asset; defaults to the JWT subject. */
  account?: string;
  /** Fiat amount (with a quote) or asset amount, as a decimal string. */
  amount?: string;
  /** SEP-38 quote id; switches to /deposit-exchange. */
  quoteId?: string;
  /** SEP-6 funding method (bank_account for TRY). */
  fundingMethod?: string;
  /** Legacy `type` field some anchors still read. */
  type?: string;
  memo?: string;
  memoType?: MemoType;
  /** Let the anchor fall back to a claimable balance if no trustline. */
  claimableBalanceSupported?: boolean;
  signal?: AbortSignal;
}

/**
 * Open a deposit and return the bank instructions. With a quote id the call
 * goes to /deposit-exchange so the quoted rate is honoured.
 */
export function startDeposit(
  anchor: AnchorConfig,
  token: string,
  request: DepositRequest = {}
): Promise<DepositInstructions> {
  const fundingMethod = request.fundingMethod ?? "bank_account";

  const common = {
    account: request.account,
    amount: request.amount,
    funding_method: fundingMethod,
    type: request.type ?? fundingMethod,
    memo: request.memo,
    memo_type: request.memoType,
    claimable_balance_supported: request.claimableBalanceSupported,
  };

  if (request.quoteId) {
    return anchorFetch<Raw>(joinUrl(anchor.transferServer, "deposit-exchange"), {
      token,
      signal: request.signal,
      query: {
        ...common,
        destination_asset: anchor.asset.code,
        source_asset: fiatAssetId(anchor.fiatCode),
        quote_id: request.quoteId,
      },
    }).then(parseDepositResponse);
  }

  return anchorFetch<Raw>(joinUrl(anchor.transferServer, "deposit"), {
    token,
    signal: request.signal,
    query: { ...common, asset_code: anchor.asset.code },
  }).then(parseDepositResponse);
}

export interface WithdrawRequest {
  account?: string;
  /** Asset amount to withdraw, as a decimal string. */
  amount?: string;
  /** SEP-38 quote id; switches to /withdraw-exchange. */
  quoteId?: string;
  /** SEP-6 withdrawal type (bank_account for TRY). */
  type?: string;
  /** Bank destination fields (SEP-9 names such as dest / dest_extra). */
  fields?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

/**
 * Open a withdrawal and return where to send the asset (anchor account +
 * memo). With a quote id the call goes to /withdraw-exchange.
 */
export function startWithdraw(
  anchor: AnchorConfig,
  token: string,
  request: WithdrawRequest = {}
): Promise<WithdrawInstructions> {
  const common = {
    account: request.account,
    amount: request.amount,
    type: request.type ?? "bank_account",
    ...(request.fields ?? {}),
  };

  if (request.quoteId) {
    return anchorFetch<Raw>(joinUrl(anchor.transferServer, "withdraw-exchange"), {
      token,
      signal: request.signal,
      query: {
        ...common,
        source_asset: anchor.asset.code,
        destination_asset: fiatAssetId(anchor.fiatCode),
        quote_id: request.quoteId,
      },
    }).then(parseWithdrawResponse);
  }

  return anchorFetch<Raw>(joinUrl(anchor.transferServer, "withdraw"), {
    token,
    signal: request.signal,
    query: { ...common, asset_code: anchor.asset.code },
  }).then(parseWithdrawResponse);
}

export type TransactionQuery =
  | { id: string }
  | { stellarTransactionId: string }
  | { externalTransactionId: string };

/** GET /transaction: one transaction by anchor id, Stellar hash, or bank reference. */
export function getTransaction(
  anchor: AnchorConfig,
  token: string,
  query: TransactionQuery,
  signal?: AbortSignal
): Promise<Sep6Transaction> {
  const params =
    "id" in query
      ? { id: query.id }
      : "stellarTransactionId" in query
        ? { stellar_transaction_id: query.stellarTransactionId }
        : { external_transaction_id: query.externalTransactionId };

  return anchorFetch<{ transaction?: Raw }>(
    joinUrl(anchor.transferServer, "transaction"),
    { token, query: params, signal }
  ).then((response) => {
    if (!response.transaction) {
      throw new AnchorError("NOT_FOUND", "The anchor returned no transaction.");
    }

    return parseTransaction(response.transaction);
  });
}

export interface ListTransactionsOptions {
  kind?: "deposit" | "withdrawal";
  limit?: number;
  noOlderThan?: string;
  pagingId?: string;
  account?: string;
  signal?: AbortSignal;
}

/** GET /transactions: history for the authenticated account, newest first. */
export function listTransactions(
  anchor: AnchorConfig,
  token: string,
  options: ListTransactionsOptions = {}
): Promise<Sep6Transaction[]> {
  return anchorFetch<{ transactions?: Raw[] }>(
    joinUrl(anchor.transferServer, "transactions"),
    {
      token,
      signal: options.signal,
      query: {
        asset_code: anchor.asset.code,
        kind: options.kind,
        limit: options.limit,
        no_older_than: options.noOlderThan,
        paging_id: options.pagingId,
        account: options.account,
      },
    }
  ).then((response) => (response.transactions ?? []).map(parseTransaction));
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called on every poll, including the first. */
  onUpdate?: (transaction: Sep6Transaction) => void;
  /** Stop early when this returns true (terminal statuses always stop). */
  until?: (transaction: Sep6Transaction) => boolean;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnchorError("CANCELLED", "Polling was cancelled."));
      return;
    }

    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new AnchorError("CANCELLED", "Polling was cancelled."));
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll GET /transaction until the status is terminal (or `until` says stop).
 * Resolves with the last transaction seen; never resolves on "error".
 */
export async function pollTransaction(
  anchor: AnchorConfig,
  token: string,
  id: string,
  options: PollOptions = {}
): Promise<Sep6Transaction> {
  const intervalMs = options.intervalMs ?? 3_000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;

  let last: Sep6Transaction | undefined;

  for (;;) {
    const transaction = await getTransaction(
      anchor,
      token,
      { id },
      options.signal
    );

    options.onUpdate?.(transaction);
    last = transaction;

    if (transaction.status === "error") {
      throw new AnchorError(
        "TRANSACTION_FAILED",
        transaction.message ?? `The anchor reported transaction ${id} as failed.`,
        { details: transaction }
      );
    }

    if (isTerminalStatus(transaction.status) || options.until?.(transaction)) {
      return transaction;
    }

    if (Date.now() + intervalMs > deadline) {
      throw new AnchorError(
        "POLL_TIMEOUT",
        `Still "${STATUS_LABELS[last.status] ?? last.status}" after ${Math.round(
          timeoutMs / 1000
        )}s. The anchor keeps processing; check the transaction later.`,
        { details: last }
      );
    }

    await sleep(intervalMs, options.signal);
  }
}

/* ------------------------------------------------------------------ */
/* Sandbox helper (NOT part of SEP-6)                                  */
/* ------------------------------------------------------------------ */

/**
 * Simulate the incoming fiat transfer for a pending deposit. This is a
 * sandbox-only extension of the mock anchor; on a real anchor the bank does
 * this. Refuses to run unless ANCHOR_SANDBOX is on.
 */
export function simulateBankTransfer(
  anchor: AnchorConfig,
  transactionId: string,
  amount?: string
): Promise<Sep6Transaction> {
  if (!ANCHOR_SANDBOX) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      "Bank simulation is only available against a sandbox anchor."
    );
  }

  return anchorFetch<{ transaction?: Raw }>(
    joinUrl(
      anchor.transferServer,
      `tx/${encodeURIComponent(transactionId)}/simulate-bank-transfer`
    ),
    { method: "POST", body: amount ? { amount } : {} }
  ).then((response) =>
    response.transaction
      ? parseTransaction(response.transaction)
      : ({ id: transactionId, kind: "deposit", status: "pending_anchor" } as Sep6Transaction)
  );
}
