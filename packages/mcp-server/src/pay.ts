/*
 * pay_and_fetch: fetch a URL, and if it answers 402, pay it from the tab.
 *
 * WHO THIS CAN PAY. Sellers whose x402 facilitator accepts a smart-account
 * payer -- in practice, one running facilitator.ts. Not arbitrary x402
 * endpoints: the public facilitator's event check refuses the spending-limit
 * policy's event, and its fee ceiling refuses the cost of a smart-account
 * transfer (deployments/testnet.json, doneTests.x402Spike). Such a seller
 * answers the paid retry with a refusal; nothing is paid.
 *
 * WHAT IS ENFORCED WHERE. The per-call cap (max_amount) and idempotency are
 * this server's. The tab's cap is the chain's: an over-cap payment is refused
 * by the spending-limit policy when the signed entry is simulated, before
 * anything reaches the seller, and the same invocation is refused on chain.
 *
 * IDEMPOTENCY. A request is (tab, url, max_amount, request_id). The first call
 * records `pending` BEFORE the payment signature leaves this process, so an
 * identical second call -- concurrent or later, in this process or after a
 * restart -- never signs a second payment. It gets the settled result back, or
 * a refusal to proceed if the outcome is not known. Passing a new request_id is
 * how a caller deliberately pays the same URL again.
 */

import { createHash } from "node:crypto";

import {
  decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";

import { explorerTx } from "./chain.ts";
import type { PaymentRecord, Receipt, Store, Tab } from "./state.ts";
import { fromBaseUnits, toBaseUnits } from "./tabs.ts";
import { AccountRefusal, X402_NETWORK } from "./x402Scheme.ts";

/** Stored and returned body size; the rest is dropped and flagged. */
const MAX_BODY_CHARS = 32_000;

export interface PayArgs {
  url: string;
  max_amount: string;
  tab_id?: string;
  request_id?: string;
}

export interface PayDeps {
  store: Store;
  fetch: typeof globalThis.fetch;
  tokenDecimals: number;
  /** Symbol every reported amount carries, e.g. "TAB". */
  tokenSymbol: string;
  /** One sentence saying what the token is, shown with every result. */
  tokenDescription: string;
  /**
   * Sign the x402 payload for the one requirement chosen. In the server this is
   * smartAccountExactScheme behind an x402Client; tests substitute it.
   */
  createPayload: (tab: Tab, maxAmount: bigint, paymentRequired: PaymentRequired) => Promise<PaymentPayload>;
  /**
   * What is left under the tab's cap, in base units, read from the policy on
   * chain. Only used to word a spending-limit refusal; optional.
   */
  remaining?: (tab: Tab) => Promise<bigint>;
}

export interface PayResult {
  tab_id: string;
  url: string;
  http_status: number;
  paid: boolean;
  /** True when this answer is the stored result of an earlier identical call. */
  replayed: boolean;
  /** With its token symbol, e.g. "0.0001 TAB". */
  amount?: string;
  token: string;
  pay_to?: string;
  tx?: string;
  explorer?: string;
  body: string;
  body_truncated: boolean;
}

const requestKey = (tab: Tab, url: string, maxAmount: bigint, requestId: string | null) =>
  createHash("sha256").update(JSON.stringify([tab.tabId, url, maxAmount.toString(), requestId])).digest("hex");

const clip = (text: string) => ({
  body: text.slice(0, MAX_BODY_CHARS),
  bodyTruncated: text.length > MAX_BODY_CHARS,
});

/**
 * The seller's refusal reason for a paid retry, if it gave one: from the
 * PAYMENT-REQUIRED header's `error`, else a JSON body's `error`.
 */
function refusalReason(res: Response, text: string): string | undefined {
  try {
    const header = res.headers.get("PAYMENT-REQUIRED");
    const error = header ? decodePaymentRequiredHeader(header).error : undefined;
    if (error) return error;
  } catch {
    // no decodable header
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

export function createPayer(deps: PayDeps) {
  const inFlight = new Map<string, Promise<PayResult>>();

  const units = (base: bigint) => `${fromBaseUnits(base, deps.tokenDecimals)} ${deps.tokenSymbol}`;

  /**
   * Every attempt that does not settle is written to the receipt log too, with
   * the reason and what stopped it: a bill that only lists successes hides the
   * refusals that show the limits working.
   */
  const trace = (tab: Tab, url: string, fields: Omit<Receipt, "tabId" | "at" | "endpoint" | "asset">) =>
    deps.store.appendReceipt({
      tabId: tab.tabId,
      at: new Date().toISOString(),
      endpoint: url,
      asset: deps.tokenSymbol,
      ...fields,
    });

  const fromRecord = (r: PaymentRecord, replayed: boolean): PayResult => ({
    tab_id: r.tabId,
    url: r.url,
    http_status: r.httpStatus ?? 0,
    paid: r.status === "settled",
    replayed,
    amount: r.amount ? units(BigInt(r.amount)) : undefined,
    token: deps.tokenDescription,
    pay_to: r.payTo,
    tx: r.tx,
    explorer: r.tx ? explorerTx(r.tx) : undefined,
    body: r.body ?? "",
    body_truncated: r.bodyTruncated ?? false,
  });

  /**
   * One sentence for a refusal by the smart account: who refused, the numbers
   * that made it refuse, and the contract error with its meaning.
   */
  async function accountRefusalMessage(error: AccountRefusal, tab: Tab, price: bigint): Promise<string> {
    const nothing = "Nothing was sent or paid.";

    switch (error.code) {
      case "3221": {
        const left = deps.remaining ? await deps.remaining(tab).catch(() => null) : null;
        const numbers =
          left === null
            ? `the price, ${units(price)}, would take this tab over its cap`
            : `the price, ${units(price)}, is more than the ${units(left)} left on this tab`;
        return (
          `The smart account's on-chain spending-limit policy refused this payment: ${numbers} ` +
          `(Error(Contract, #3221), SpendingLimitExceeded: the tab's cap for its window would be exceeded). ${nothing}`
        );
      }
      case "3002":
        return (
          `The smart account refused this payment on chain: this tab has expired ` +
          `(Error(Contract, #3002), UnvalidatedContext: the tab's rule is past its expiry ledger). ${nothing}`
        );
      case "3000":
        return (
          `The smart account refused this payment on chain: this tab's rule no longer exists ` +
          `(Error(Contract, #3000), ContextRuleNotFound: the tab was closed). ${nothing}`
        );
      default:
        return `The smart account refused this payment on chain (${error.message}). ${nothing}`;
    }
  }

  async function pay(tab: Tab, args: PayArgs, maxAmount: bigint, key: string): Promise<PayResult> {
    const existing = deps.store.getPayment(key);

    if (existing?.status === "settled") return fromRecord(existing, true);
    if (existing && existing.status !== "refused") {
      throw new Error(
        `An identical request (${existing.status}, started ${existing.startedAt}) may already have paid. ` +
          `Not paying again. Check tab_status for the tab's on-chain spend; pass a new request_id to pay again deliberately.`
      );
    }

    const first = await deps.fetch(args.url);
    const firstText = await first.text();

    if (first.status !== 402) {
      const { body, bodyTruncated } = clip(firstText);
      return {
        tab_id: tab.tabId, url: args.url, http_status: first.status, paid: false, replayed: false,
        token: deps.tokenDescription, body, body_truncated: bodyTruncated,
      };
    }

    // x402 v2 only: Stellar has no v1, and v2 carries the challenge in a header.
    let paymentRequired: PaymentRequired;
    try {
      const header = first.headers.get("PAYMENT-REQUIRED");
      if (!header) throw new Error("no PAYMENT-REQUIRED header");
      paymentRequired = decodePaymentRequiredHeader(header);
    } catch (error) {
      throw new Error(`${args.url} answered 402 without a readable x402 v2 challenge: ${(error as Error).message}`, {
        cause: error,
      });
    }

    const usable = paymentRequired.accepts
      .filter((r) => r.scheme === "exact" && r.network === X402_NETWORK && r.asset === tab.token)
      .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));

    if (usable.length === 0) {
      const offered = paymentRequired.accepts.map((r) => `${r.scheme}/${r.network}/${r.asset}`).join(", ");
      const reason = `no payment option this tab can use (exact, ${X402_NETWORK}, ${deps.tokenSymbol} ${tab.token}); offered: ${offered}`;
      trace(tab, args.url, { kind: "refused", refusedBy: "payment terms", reason });
      throw new Error(`No payment option this tab can use (exact, ${X402_NETWORK}, ${deps.tokenSymbol}). Offered: ${offered}. Nothing was paid.`);
    }

    const chosen: PaymentRequirements = usable[0];
    const price = BigInt(chosen.amount);

    // The per-call cap: checked before anything is signed.
    if (price > maxAmount) {
      const reason = `price ${units(price)} exceeds max_amount ${units(maxAmount)}`;
      trace(tab, args.url, { kind: "refused", refusedBy: "per-call cap", amount: fromBaseUnits(price, deps.tokenDecimals), to: chosen.payTo, reason });
      throw new Error(`Price ${units(price)} exceeds max_amount ${units(maxAmount)}. Nothing was signed or paid.`);
    }

    const now = () => new Date().toISOString();
    const record: PaymentRecord = {
      key,
      tabId: tab.tabId,
      url: args.url,
      maxAmount: maxAmount.toString(),
      requestId: args.request_id ?? null,
      status: "pending",
      startedAt: now(),
      updatedAt: now(),
      amount: chosen.amount,
      payTo: chosen.payTo,
    };
    const save = (patch: Partial<PaymentRecord>) => {
      Object.assign(record, patch, { updatedAt: now() });
      deps.store.putPayment(record);
    };

    // Written before signing, so a crash from here on leaves a record that blocks a second payment.
    save({});

    let payload: PaymentPayload;
    try {
      payload = await deps.createPayload(tab, maxAmount, { ...paymentRequired, accepts: [chosen] });
    } catch (error) {
      // Nothing left this process: the account refused the signed entry, or signing failed.
      const message =
        error instanceof AccountRefusal
          ? await accountRefusalMessage(error, tab, price)
          : `The payment could not be signed: ${(error as Error).message}. Nothing was sent or paid.`;
      save({ status: "refused", error: message });
      trace(tab, args.url, {
        kind: "refused",
        refusedBy: error instanceof AccountRefusal ? "on-chain policy" : "signing",
        amount: fromBaseUnits(price, deps.tokenDecimals),
        to: chosen.payTo,
        reason: message,
      });
      throw new Error(message, { cause: error });
    }

    let second: Response;
    let secondText: string;
    try {
      second = await deps.fetch(args.url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
      secondText = await second.text();
    } catch (error) {
      save({ status: "unconfirmed", error: (error as Error).message });
      trace(tab, args.url, {
        kind: "unconfirmed",
        amount: fromBaseUnits(price, deps.tokenDecimals),
        to: chosen.payTo,
        reason: `request failed after the payment signature was sent: ${(error as Error).message}`,
      });
      throw new Error(`The paid request failed after the payment signature was sent; outcome unknown: ${(error as Error).message}`,
        { cause: error }
      );
    }

    const { body, bodyTruncated } = clip(secondText);

    let settle;
    try {
      const header = second.headers.get("PAYMENT-RESPONSE");
      settle = header ? decodePaymentResponseHeader(header) : undefined;
    } catch {
      settle = undefined;
    }

    if (second.ok && settle?.success && settle.transaction) {
      save({ status: "settled", tx: settle.transaction, httpStatus: second.status, body, bodyTruncated });
      deps.store.appendReceipt({
        tabId: tab.tabId,
        at: record.updatedAt,
        kind: "payment",
        amount: fromBaseUnits(price, deps.tokenDecimals),
        asset: deps.tokenSymbol,
        to: chosen.payTo,
        tx: settle.transaction,
        endpoint: args.url,
      });
      return fromRecord(record, false);
    }

    const reason = refusalReason(second, secondText) ?? settle?.errorReason;

    /*
     * Every upstream verify refusal is an `invalid_*` reason, and verify runs
     * before the facilitator submits anything, so those are safe to call
     * refused. Anything else -- a settle failure, a 5xx, a 200 without a
     * settlement -- may have left a submitted transaction behind.
     *
     * This trusts the seller's account of its facilitator's answer. A seller
     * that settles and then claims an invalid_* refusal can get paid twice on
     * a retry; the tab's on-chain cap is the bound on that, not this code.
     */
    if (second.status === 402 && reason?.startsWith("invalid_")) {
      save({ status: "refused", httpStatus: second.status, error: reason });
      trace(tab, args.url, { kind: "refused", refusedBy: "seller's facilitator", amount: fromBaseUnits(price, deps.tokenDecimals), to: chosen.payTo, reason });
      throw new Error(
        `The seller's facilitator refused the payment: ${reason}. Nothing was paid. ` +
          `If the reason concerns fees or events, the seller's facilitator does not accept smart-account payers.`
      );
    }

    save({ status: "unconfirmed", httpStatus: second.status, body, bodyTruncated, error: reason });
    trace(tab, args.url, {
      kind: "unconfirmed",
      amount: fromBaseUnits(price, deps.tokenDecimals),
      to: chosen.payTo,
      reason: `no settlement came back (HTTP ${second.status}${reason ? `, ${reason}` : ""})`,
    });
    throw new Error(
      `No settlement came back (HTTP ${second.status}${reason ? `, ${reason}` : ""}). The payment may or may not ` +
        `have settled; it will not be retried automatically. Check tab_status.`
    );
  }

  return async function payAndFetch(tab: Tab, args: PayArgs): Promise<PayResult> {
    if (tab.status !== "open") throw new Error(`${tab.tabId} is ${tab.status}; open a tab to pay`);

    const maxAmount = toBaseUnits(args.max_amount, deps.tokenDecimals, "max_amount");
    const key = requestKey(tab, args.url, maxAmount, args.request_id ?? null);

    // Concurrent identical calls in this process share one attempt.
    const running = inFlight.get(key);
    if (running) return running.then((r) => ({ ...r, replayed: true }));

    const attempt = pay(tab, args, maxAmount, key).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}
