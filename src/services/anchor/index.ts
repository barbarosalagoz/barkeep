/*
 * TRY on/off-ramp via the portable SEP path (SEP-1, SEP-10, SEP-6, SEP-38).
 *
 * This module composes the per-SEP clients into the two flows PromptRail
 * needs:
 *
 *   beginDeposit  -> TRY in (bank transfer)  -> USDC credited to the user
 *   runWithdraw   -> USDC out (with memo)    -> TRY paid to the provider
 *
 * No partner API key is involved anywhere; the only anchor-specific inputs
 * are the home domain and network in src/config/stellar.ts.
 */

import { insufficientBalance } from "../../errors";

import { AnchorError } from "./errors";
import { ensureTrustline, getAssetHolding, sendAssetPayment } from "./horizon";
import type { TrustlineResult } from "./horizon";
import { discoverAnchor } from "./sep1";
import type { AnchorConfig, DiscoverOptions } from "./sep1";
import { authenticate, isSessionValid } from "./sep10";
import type { AuthSession, XdrSigner } from "./sep10";
import { pollTransaction, startDeposit, startWithdraw } from "./sep6";
import type {
  DepositInstructions,
  PollOptions,
  Sep6Transaction,
  WithdrawInstructions,
} from "./sep6";

export * from "./errors";
export * from "./horizon";
export * from "./sep1";
export * from "./sep10";
export * from "./sep38";
export * from "./sep6";

/* ------------------------------------------------------------------ */
/* Session cache                                                       */
/* ------------------------------------------------------------------ */

const sessions = new Map<string, AuthSession>();

const sessionKey = (homeDomain: string, account: string) =>
  `${homeDomain}|${account}`;

export interface AnchorConnection {
  anchor: AnchorConfig;
  session: AuthSession;
}

export interface ConnectOptions extends DiscoverOptions {
  /** Ignore a cached token and re-run SEP-10. */
  reauthenticate?: boolean;
  signal?: AbortSignal;
}

/**
 * Discover the anchor (SEP-1) and log the account in (SEP-10), reusing a
 * still-valid token when one is cached for this account.
 */
export async function connectAnchor(
  account: string,
  sign: XdrSigner,
  options: ConnectOptions = {}
): Promise<AnchorConnection> {
  const anchor = await discoverAnchor(options);
  const key = sessionKey(anchor.homeDomain, account);
  const cached = sessions.get(key);

  if (cached && !options.reauthenticate && isSessionValid(cached)) {
    return { anchor, session: cached };
  }

  const session = await authenticate(anchor, account, sign, {
    signal: options.signal,
  });

  sessions.set(key, session);

  return { anchor, session };
}

export function forgetAnchorSessions(account?: string): void {
  if (!account) {
    sessions.clear();
    return;
  }

  for (const key of Array.from(sessions.keys())) {
    if (key.endsWith(`|${account}`)) {
      sessions.delete(key);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Deposit: TRY -> USDC                                                */
/* ------------------------------------------------------------------ */

export type DepositPhase =
  | "discovering"
  | "authenticating"
  | "trustline"
  | "starting"
  | "awaiting_bank";

export interface BeginDepositOptions extends ConnectOptions {
  account: string;
  sign: XdrSigner;
  /** Fiat amount as a decimal string (e.g. "250.00"). */
  amount: string;
  /** SEP-38 quote id to lock the rate. */
  quoteId?: string;
  onPhase?: (phase: DepositPhase) => void;
}

export interface DepositStart extends AnchorConnection {
  instructions: DepositInstructions;
  trustline: TrustlineResult;
}

/**
 * Prepare a deposit: connect, make sure the account can receive the asset
 * (creating the trustline if missing), and open the SEP-6 deposit. Returns
 * the bank instructions to show the user; call watchDeposit to follow it.
 */
export async function beginDeposit(
  options: BeginDepositOptions
): Promise<DepositStart> {
  const { account, sign, onPhase } = options;

  onPhase?.("discovering");
  onPhase?.("authenticating");

  const connection = await connectAnchor(account, sign, options);

  onPhase?.("trustline");

  const trustline = await ensureTrustline(account, connection.anchor.asset, sign);

  onPhase?.("starting");

  const instructions = await startDeposit(
    connection.anchor,
    connection.session.token,
    {
      account,
      amount: options.amount,
      quoteId: options.quoteId,
      signal: options.signal,
    }
  );

  onPhase?.("awaiting_bank");

  return { ...connection, instructions, trustline };
}

export interface WatchDepositOptions extends PollOptions {
  account: string;
  sign: XdrSigner;
}

/**
 * Follow a deposit to completion. If the anchor parks it in pending_trust
 * (trustline removed or never created), add the trustline and keep polling.
 */
export async function watchDeposit(
  connection: AnchorConnection,
  transactionId: string,
  options: WatchDepositOptions
): Promise<Sep6Transaction> {
  const { account, sign, ...poll } = options;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const transaction = await pollTransaction(
      connection.anchor,
      connection.session.token,
      transactionId,
      {
        ...poll,
        until: (current) =>
          current.status === "pending_trust" || (poll.until?.(current) ?? false),
      }
    );

    if (transaction.status !== "pending_trust") {
      return transaction;
    }

    await ensureTrustline(account, connection.anchor.asset, sign);
  }

  throw new AnchorError(
    "POLL_TIMEOUT",
    "The anchor still reports a missing trustline after adding one."
  );
}

/* ------------------------------------------------------------------ */
/* Withdraw: USDC -> TRY (provider payout)                             */
/* ------------------------------------------------------------------ */

export type WithdrawPhase =
  | "discovering"
  | "authenticating"
  | "starting"
  | "paying"
  | "polling";

export interface RunWithdrawOptions extends ConnectOptions {
  account: string;
  sign: XdrSigner;
  /** Asset amount as a decimal string (e.g. "4.08"). */
  amount: string;
  /** SEP-38 quote id to lock the rate. */
  quoteId?: string;
  /** Bank destination fields the anchor asks for, if any. */
  fields?: Record<string, string | undefined>;
  onPhase?: (phase: WithdrawPhase) => void;
  onPayment?: (hash: string) => void;
  poll?: PollOptions;
}

export interface WithdrawResult extends AnchorConnection {
  instructions: WithdrawInstructions;
  paymentHash: string;
  transaction: Sep6Transaction;
}

/**
 * Run a withdrawal end to end: connect, open the SEP-6 withdrawal, pay the
 * asset to the anchor with the memo it issued, then poll until the anchor
 * reports the fiat payout as completed.
 */
export async function runWithdraw(
  options: RunWithdrawOptions
): Promise<WithdrawResult> {
  const { account, sign, onPhase } = options;

  onPhase?.("discovering");
  onPhase?.("authenticating");

  const connection = await connectAnchor(account, sign, options);
  const { anchor, session } = connection;

  const holding = await getAssetHolding(account, anchor.asset);

  if (!holding.hasTrustline || Number(holding.balance) < Number(options.amount)) {
    throw insufficientBalance(
      `Withdrawing ${options.amount} ${anchor.asset.code} exceeds your balance of ${holding.balance} ${anchor.asset.code}.`
    );
  }

  onPhase?.("starting");

  const instructions = await startWithdraw(anchor, session.token, {
    account,
    amount: options.amount,
    quoteId: options.quoteId,
    fields: options.fields,
    signal: options.signal,
  });

  if (!instructions.memo) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      "The anchor did not issue a memo for this withdrawal, so the payment could not be matched."
    );
  }

  onPhase?.("paying");

  const paymentHash = await sendAssetPayment(
    {
      source: account,
      destination: instructions.anchorAccount,
      asset: anchor.asset,
      amount: options.amount,
      memo: instructions.memo,
      memoType: instructions.memoType,
    },
    sign
  );

  options.onPayment?.(paymentHash);
  onPhase?.("polling");

  const transaction = await pollTransaction(anchor, session.token, instructions.id, {
    signal: options.signal,
    ...options.poll,
  });

  return { ...connection, instructions, paymentHash, transaction };
}
