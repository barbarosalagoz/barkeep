/*
 * Horizon side of the ramp: trustlines, balances and the USDC payment that
 * settles a withdrawal. Signing goes through an XdrSigner so the same code
 * serves the wallet-connected UI and the Keypair-driven tests.
 */

import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { HORIZON_URL, NETWORK_PASSPHRASE } from "../../config/stellar";
import { classifyHorizonError } from "../../errors";

import { AnchorError } from "./errors";
import type { AnchorAsset } from "./sep1";
import type { XdrSigner } from "./sep10";
import type { MemoType } from "./sep6";

const horizon = new Horizon.Server(HORIZON_URL);

export const toSdkAsset = (asset: AnchorAsset): Asset =>
  new Asset(asset.code, asset.issuer);

export interface AssetHolding {
  /** The account exists on the network. */
  funded: boolean;
  hasTrustline: boolean;
  balance: string;
  limit?: string;
  xlmBalance: string;
}

function isNotFound(error: unknown): boolean {
  const status = (error as { response?: { status?: number } }).response?.status;

  return status === 404;
}

/** Trustline state and balance of `asset` for `account`. */
export async function getAssetHolding(
  account: string,
  asset: AnchorAsset
): Promise<AssetHolding> {
  let record: Horizon.AccountResponse;

  try {
    record = await horizon.loadAccount(account);
  } catch (error) {
    if (isNotFound(error)) {
      return { funded: false, hasTrustline: false, balance: "0", xlmBalance: "0" };
    }

    throw classifyHorizonError(error);
  }

  const native = record.balances.find((line) => line.asset_type === "native");

  const line = record.balances.find(
    (entry) =>
      (entry.asset_type === "credit_alphanum4" ||
        entry.asset_type === "credit_alphanum12") &&
      entry.asset_code === asset.code &&
      entry.asset_issuer === asset.issuer
  );

  return {
    funded: true,
    hasTrustline: Boolean(line),
    balance: line ? line.balance : "0",
    limit: line && "limit" in line ? line.limit : undefined,
    xlmBalance: native ? native.balance : "0",
  };
}

async function submitSigned(
  unsignedXdr: string,
  sign: XdrSigner
): Promise<string> {
  const signedXdr = await sign(unsignedXdr);

  try {
    const result = await horizon.submitTransaction(
      TransactionBuilder.fromXdr(signedXdr, NETWORK_PASSPHRASE)
    );

    return result.hash;
  } catch (error) {
    throw classifyHorizonError(error);
  }
}

export interface TrustlineResult {
  created: boolean;
  hash?: string;
}

/**
 * Make sure `account` trusts `asset`, asking the signer for a changeTrust
 * transaction if it does not. Idempotent.
 */
export async function ensureTrustline(
  account: string,
  asset: AnchorAsset,
  sign: XdrSigner
): Promise<TrustlineResult> {
  const holding = await getAssetHolding(account, asset);

  if (holding.hasTrustline) {
    return { created: false };
  }

  if (!holding.funded) {
    throw new AnchorError(
      "ACCOUNT_NOT_FUNDED",
      "This account does not exist on the network yet, so it cannot hold a trustline.",
      { hint: "Fund it with a little XLM first (Friendbot on Testnet)." }
    );
  }

  const source = await horizon.loadAccount(account);

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: toSdkAsset(asset) }))
    .setTimeout(60)
    .build();

  const hash = await submitSigned(transaction.toEnvelope().toXdr("base64"), sign);

  return { created: true, hash };
}

function base64ToHex(value: string): string {
  const binary = atob(value);
  let hex = "";

  for (let index = 0; index < binary.length; index += 1) {
    hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }

  return hex;
}

/** Build the SDK memo the anchor asked for on a withdrawal. */
export function buildMemo(memo?: string, memoType?: MemoType): Memo {
  if (!memo) {
    return Memo.none();
  }

  switch (memoType) {
    case "text":
      return Memo.text(memo);
    case "hash":
      return Memo.hash(base64ToHex(memo));
    case "id":
    default:
      return Memo.id(memo);
  }
}

/** Normalise a user amount to the 7-decimal string Stellar accepts. */
export function normalizeAmount(amount: string, decimals = 7): string {
  const trimmed = amount.trim();

  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error("Enter a positive decimal amount.");
  }

  const [whole, fraction = ""] = trimmed.split(".");

  if (fraction.length > decimals) {
    throw new Error(`Amounts support at most ${decimals} decimal places.`);
  }

  const normalized = fraction
    ? `${whole}.${fraction.replace(/0+$/, "")}`.replace(/\.$/, "")
    : whole;

  if (Number(normalized) <= 0) {
    throw new Error("Amount must be greater than zero.");
  }

  return normalized;
}

export interface AssetPayment {
  source: string;
  destination: string;
  asset: AnchorAsset;
  amount: string;
  memo?: string;
  memoType?: MemoType;
}

/**
 * Pay `amount` of the asset to the anchor with the memo it issued. Returns
 * the Stellar transaction hash, which the anchor matches to the withdrawal.
 */
export async function sendAssetPayment(
  payment: AssetPayment,
  sign: XdrSigner
): Promise<string> {
  const source = await horizon.loadAccount(payment.source).catch((error) => {
    throw classifyHorizonError(error);
  });

  const transaction = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: payment.destination,
        asset: toSdkAsset(payment.asset),
        amount: normalizeAmount(payment.amount),
      })
    )
    .addMemo(buildMemo(payment.memo, payment.memoType))
    .setTimeout(120)
    .build();

  return submitSigned(transaction.toEnvelope().toXdr("base64"), sign);
}
