import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createPayer, type PayDeps } from "./pay.ts";
import { Store, type Tab } from "./state.ts";

/*
 * pay_and_fetch's own logic, offline: the per-call cap, idempotency and the
 * receipt. Signing and settlement are stubbed; the on-chain behaviour is
 * proved by scripts/pay-and-fetch-testnet.mjs, which stays out of CI (§11).
 */

const TOKEN = "CBXLQ3TCM6EB6KXBYDQVZ3NJO2SAL5FY5BZPMTLGQPROANSSP7RFHP3V";
const SELLER = "GA5SX5BBXI6N6TA3ZWVX5QDRISXWXHIYUDCHG6LKGIY6RUFAMS65AGX2";
const URL = "http://seller.test/paid";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const tab: Tab = {
  tabId: "tab_pay01",
  contextRuleId: 11,
  policyContract: "C_POLICY",
  token: TOKEN,
  limit: "10000",
  windowLedgers: 180,
  expiryLedger: 1_000_000,
  agentPublicKey: "GAGENT",
  payees: null,
  payeeEnforcement: "none",
  status: "open",
  openedAt: "2026-09-13T00:00:00.000Z",
  openTx: "open",
};

const challenge = (amount: string): PaymentRequired => ({
  x402Version: 2,
  resource: { url: URL },
  accepts: [
    { scheme: "exact", network: "stellar:testnet", asset: TOKEN, amount, payTo: SELLER, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } },
  ],
});

type Settle = "settled" | "invalid" | "error";

/** A seller: 402 without a signature; with one, whatever `outcome` says. */
function seller(price: string, outcome: () => Settle = () => "settled") {
  const signatures: string[] = [];
  let n = 0;

  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const sig = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
    if (!sig) {
      return new Response("{}", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(challenge(price)) } });
    }

    signatures.push(decodePaymentSignatureHeader(sig).payload.transaction as string);
    const result = outcome();
    if (result === "invalid") {
      return new Response(JSON.stringify({ error: "invalid_exact_stellar_payload_event_not_transfer" }), { status: 402 });
    }
    if (result === "error") return new Response("boom", { status: 500 });

    n++;
    return new Response(`paid content ${n}`, {
      status: 200,
      headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: `tx${n}`, network: "stellar:testnet" }) },
    });
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, signatures };
}

function setup(price: string, outcome?: () => Settle, dir = mkdtempSync(join(tmpdir(), "barkeep-pay-"))) {
  dirs.push(dir);
  const s = seller(price, outcome);
  const createPayload = vi.fn(
    async (_t: Tab, _max: bigint, pr: PaymentRequired): Promise<PaymentPayload> => ({
      x402Version: 2,
      accepted: pr.accepts[0],
      payload: { transaction: `signed-${pr.accepts[0].amount}` },
    })
  );
  const store = new Store(dir);
  const deps: PayDeps = { store, fetch: s.fetch, tokenDecimals: 7, createPayload };
  return { pay: createPayer(deps), store, createPayload, dir, ...s };
}

describe("pay_and_fetch", () => {
  it("pays once for two identical calls, and returns the stored result the second time", async () => {
    const { pay, store, createPayload, signatures } = setup("1000");

    const first = await pay(tab, { url: URL, max_amount: "0.001" });
    const second = await pay(tab, { url: URL, max_amount: "0.001" });

    expect(first).toMatchObject({ paid: true, replayed: false, tx: "tx1", amount: "0.0001", body: "paid content 1" });
    expect(second).toMatchObject({ paid: true, replayed: true, tx: "tx1", body: "paid content 1" });
    expect(createPayload).toHaveBeenCalledTimes(1);
    expect(signatures).toHaveLength(1);
    expect(store.receipts(tab.tabId).filter((r) => r.kind === "payment")).toHaveLength(1);
  });

  it("pays once for two identical calls made concurrently", async () => {
    const { pay, signatures } = setup("1000");

    const [a, b] = await Promise.all([
      pay(tab, { url: URL, max_amount: "0.001" }),
      pay(tab, { url: URL, max_amount: "0.001" }),
    ]);

    expect(a.tx).toBe("tx1");
    expect(b.tx).toBe("tx1");
    expect(signatures).toHaveLength(1);
  });

  it("stays idempotent across a restart", async () => {
    const { pay, dir, signatures } = setup("1000");
    await pay(tab, { url: URL, max_amount: "0.001" });

    const restarted = setup("1000", undefined, dir);
    const again = await restarted.pay(tab, { url: URL, max_amount: "0.001" });

    expect(again).toMatchObject({ replayed: true, tx: "tx1" });
    expect(restarted.fetch).not.toHaveBeenCalled();
    expect(signatures).toHaveLength(1);
  });

  it("pays again when the caller passes a new request_id", async () => {
    const { pay, signatures } = setup("1000");

    await pay(tab, { url: URL, max_amount: "0.001", request_id: "a" });
    const b = await pay(tab, { url: URL, max_amount: "0.001", request_id: "b" });

    expect(b.tx).toBe("tx2");
    expect(signatures).toHaveLength(2);
  });

  it("writes a receipt with tx, amount, endpoint, timestamp and tab id", async () => {
    const { pay, store } = setup("2500");
    await pay(tab, { url: URL, max_amount: "0.001" });

    const [receipt] = store.receipts(tab.tabId);
    expect(receipt).toMatchObject({ tabId: tab.tabId, kind: "payment", tx: "tx1", amount: "0.00025", endpoint: URL, to: SELLER });
    expect(Date.parse(receipt.at)).not.toBeNaN();
  });

  it("refuses a price above max_amount before signing anything", async () => {
    const { pay, createPayload, signatures, store } = setup("20000");

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).rejects.toThrow(/exceeds max_amount.*Nothing was signed/);
    expect(createPayload).not.toHaveBeenCalled();
    expect(signatures).toHaveLength(0);
    expect(store.receipts()).toHaveLength(0);
  });

  it("records an account refusal as refused, and lets an identical call try again", async () => {
    const { pay, createPayload, signatures } = setup("1000");
    createPayload.mockRejectedValueOnce(new Error("refused by the account: HostError: Error(Contract, #3221)"));

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).rejects.toThrow(/#3221/);
    expect(signatures).toHaveLength(0);

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).resolves.toMatchObject({ paid: true });
    expect(createPayload).toHaveBeenCalledTimes(2);
  });

  it("treats a facilitator verify refusal as nothing paid", async () => {
    let n = 0;
    const { pay, store } = setup("1000", () => (n++ === 0 ? "invalid" : "settled"));

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).rejects.toThrow(/invalid_exact_stellar_payload_event_not_transfer.*Nothing was paid/);
    expect(store.receipts()).toHaveLength(0);
    await expect(pay(tab, { url: URL, max_amount: "0.001" })).resolves.toMatchObject({ paid: true });
  });

  it("does not retry automatically when the outcome is unknown", async () => {
    const { pay, fetch, signatures } = setup("1000", () => "error");

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).rejects.toThrow(/may or may not have settled/);
    const calls = vi.mocked(fetch).mock.calls.length;

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).rejects.toThrow(/Not paying again/);
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    expect(signatures).toHaveLength(1);
  });

  it("returns a free resource without paying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "barkeep-pay-"));
    dirs.push(dir);
    const fetch = vi.fn(async () => new Response("free", { status: 200 })) as unknown as typeof globalThis.fetch;
    const createPayload = vi.fn();
    const pay = createPayer({ store: new Store(dir), fetch, tokenDecimals: 7, createPayload });

    await expect(pay(tab, { url: URL, max_amount: "0.001" })).resolves.toMatchObject({ paid: false, http_status: 200, body: "free" });
    expect(createPayload).not.toHaveBeenCalled();
  });

  it("refuses a closed tab", async () => {
    const { pay } = setup("1000");
    await expect(pay({ ...tab, status: "closed" }, { url: URL, max_amount: "0.001" })).rejects.toThrow(/closed/);
  });
});

describe("contractRefusal", () => {
  it("reduces a simulation failure to the contract's error code", async () => {
    const { contractRefusal } = await import("./x402Scheme.ts");
    const sim = "HostError: Error(Auth, InvalidAction)\n\nEvent log (newest first):\n  0: ... Error(Contract, #3221) ...";

    expect(contractRefusal(sim)).toBe("Error(Contract, #3221) SpendingLimitExceeded -- over the tab's remaining cap");
    expect(contractRefusal("HostError: something else\nmore")).toBe("HostError: something else");
  });
});
