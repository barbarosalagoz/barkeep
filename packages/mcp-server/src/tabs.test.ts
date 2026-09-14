import { Account, Keypair, MuxedAccount, xdr } from "@stellar/stellar-sdk";
import { afterAll, describe, expect, it } from "vitest";

import type { Chain } from "./chain.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeOtherRules, presentPayResult } from "./index.ts";
import { Store, type Tab } from "./state.ts";
import { rawEd25519Key } from "./keys.ts";
import {
  MAX_PAYEES, PAYEES_NOT_RESTRICTED, describePayees, payeeSelection, reportReceipt, rulesListingKey, tabStatus,
  type TabConfig,
} from "./tabs.ts";

/*
 * close_tab's report on where the agent key still sits, offline. The live
 * account really does keep expired rules listing the key (ids 1-8, from the
 * 2026-09-12 done-tests), which is why close_tab must check rather than assert.
 */

const ACCOUNT = "CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH";
const VERIFIER = "CCVOYY3CQGSJV42INAUOQMBSX2OIEOX355MUWRSHAW4LEHQNF3RQR5NJ";
const agent = Keypair.random().publicKey();
const human = Keypair.random().publicKey();

type FakeRule = { id: number; name: string; valid_until?: number; key: string };

/** A Chain that answers only what rulesListingKey asks: NextId, the ledger, and get_context_rule. */
function fakeChain(nextId: number, rules: FakeRule[], ledger = 1000, failOn?: number): Chain {
  const storage = [
    new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Count")]), val: xdr.ScVal.scvU32(rules.length) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("NextId")]), val: xdr.ScVal.scvU32(nextId) }),
  ];

  return {
    server: {
      getLedgerEntries: async () => ({
        entries: [{ val: { contractData: () => ({ val: () => ({ instance: () => ({ storage: () => storage }) }) }) } }],
      }),
    },
    latestLedger: async () => ledger,
    read: async ({ args }: { args: xdr.ScVal[] }) => {
      const id = args[0].u32();
      if (id === failOn) throw new Error("get_context_rule: network unreachable");

      const rule = rules.find((r) => r.id === id);
      if (!rule) throw new Error("get_context_rule: HostError: Error(Contract, #3000)");

      return {
        id: rule.id,
        name: rule.name,
        valid_until: rule.valid_until,
        signers: [["External", VERIFIER, rawEd25519Key(rule.key)]],
      };
    },
  } as unknown as Chain;
}

describe("rulesListingKey", () => {
  it("finds every rule still listing the key, marks expiry, and skips removed ids", async () => {
    const chain = fakeChain(17, [
      { id: 0, name: "human", key: human },
      { id: 1, name: "agent", valid_until: 900, key: agent },
      { id: 2, name: "agent", valid_until: 999, key: agent },
      { id: 9, name: "agent", valid_until: 1000, key: agent }, // valid_until == ledger: still valid
    ]);

    const result = await rulesListingKey(chain, ACCOUNT, agent);

    expect(result.checkedRules).toBe(4);
    expect(result.listing).toEqual([
      { id: 1, name: "agent", validUntil: 900, expired: true },
      { id: 2, name: "agent", validUntil: 999, expired: true },
      { id: 9, name: "agent", validUntil: 1000, expired: false },
    ]);
  });

  it("throws on a failure other than a removed rule, instead of reporting the key absent", async () => {
    const chain = fakeChain(5, [{ id: 3, name: "agent", valid_until: 900, key: agent }], 1000, 3);
    await expect(rulesListingKey(chain, ACCOUNT, agent)).rejects.toThrow(/network unreachable/);
  });
});

describe("describeOtherRules", () => {
  it("never claims the key is gone while expired rules still list it", () => {
    const text = describeOtherRules({
      checkedRules: 9,
      listing: [1, 2, 3].map((id) => ({ id, name: "agent", validUntil: 100, expired: true })),
    });

    expect(text).toMatch(/still listed on 3 other rule\(s\) \(1, 2, 3\), all expired/);
    expect(text).toMatch(/#3002/);
    expect(text).not.toMatch(/no longer a signer on any/);
  });

  it("warns when a live rule still lists the key", () => {
    const text = describeOtherRules({
      checkedRules: 3,
      listing: [
        { id: 4, name: "agent", validUntil: null, expired: false },
        { id: 1, name: "agent", validUntil: 100, expired: true },
      ],
    });

    expect(text).toMatch(/^WARNING: .* 1 live rule\(s\) \(4\) and can still spend/);
  });

  it("says the key is on no other rule only when every rule was read", () => {
    expect(describeOtherRules({ checkedRules: 2, listing: [] })).toBe(
      "The agent key is on no other rule. Checked all 2 rules on the account."
    );
    expect(describeOtherRules({ error: "rpc down" })).toMatch(/^Not checked \(rpc down\)\. The agent key may still be a signer/);
  });
});

describe("tab_status output", () => {
  const dir = mkdtempSync(join(tmpdir(), "barkeep-status-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const cfg: TabConfig = {
    token: "C_TOKEN", tokenDecimals: 7, tokenSymbol: "TAB", tokenDescription: "TAB, a test asset. Not USDC.",
    policyContract: "C_POLICY", payeeAllowlistPolicy: "C_ALLOWLIST", verifierEd25519: VERIFIER, smartAccount: ACCOUNT,
    adminContextRuleId: 0,
  };
  const tab: Tab = {
    tabId: "tab_shape01", contextRuleId: 18, policyContract: "C_POLICY", token: "C_TOKEN", limit: "5000",
    windowLedgers: 720, window: "PT1H", expiryLedger: 2000, agentPublicKey: agent, payees: null,
    payeeEnforcement: "none", status: "open", openedAt: "2026-09-13T00:00:00.000Z", openTx: "open-tx",
  };
  /** Answers get_spending_limit_data, get_context_rule and get_payees, as the chain would. */
  const chainAt = (ledger: number, onChain: { policies: string[]; payees?: string[] } = { policies: ["C_POLICY"] }) =>
    ({
      latestLedger: async () => ledger,
      read: async ({ fn }: { fn: string }) => {
        if (fn === "get_spending_limit_data") return { spending_limit: 5000n, period_ledgers: 720, cached_total_spent: 1000n };
        if (fn === "get_context_rule") return { id: 18, policies: onChain.policies };
        if (fn === "get_payees") return onChain.payees;
        throw new Error(`unexpected read ${fn}`);
      },
    }) as unknown as Chain;

  const store = new Store(dir);
  store.putTab(tab);
  store.appendReceipt({ tabId: tab.tabId, at: "1", kind: "open", tx: "open-tx" });
  store.appendReceipt({ tabId: tab.tabId, at: "2", kind: "refused", amount: "0.002", asset: "TAB", endpoint: "/dataset", refusedBy: "on-chain policy", reason: "over cap" });

  it("is short, snake_case, and ends with who the tab can pay", async () => {
    const status = await tabStatus(chainAt(1284), store, cfg, tab.tabId);

    expect(Object.keys(status)).toEqual([
      "tab_id", "status", "limit", "spent", "remaining", "token", "window", "expires", "receipts", "allow_any_payee", "payees",
    ]);
    expect(status).toMatchObject({
      limit: "0.0005 TAB", spent: "0.0001 TAB", remaining: "0.0004 TAB",
      window: "PT1H (720 ledgers)", expires: "at ledger 2000, in ~60 min (716 ledgers)",
      allow_any_payee: true, payees: PAYEES_NOT_RESTRICTED,
    });
    // Receipts from before the flag existed take the tab's value.
    expect(status.receipts).toEqual([
      { at: "1", kind: "open", tx: "open-tx", allow_any_payee: true },
      { at: "2", kind: "refused", amount: "0.002 TAB", endpoint: "/dataset", refused_by: "on-chain policy", reason: "over cap", allow_any_payee: true },
    ]);
    expect(JSON.stringify(status)).not.toMatch(/tabId|refusedBy|"source"|constraints|current_ledger/);
  });

  it("carries warnings only when something has changed", async () => {
    const status = await tabStatus(chainAt(2001), store, cfg, tab.tabId);

    expect(status.status).toBe("expired");
    expect(status.warnings).toEqual([expect.stringMatching(/expired at ledger 2000/)]);
  });

  describe("payees at open_tab: fail closed", () => {
    const G1 = Keypair.random().publicKey();
    const G2 = Keypair.random().publicKey();

    it("refuses a tab with neither payees nor allow_any_payee, and says an empty list is not anyone", () => {
      for (const args of [{}, { payees: [] }, { allow_any_payee: false }, { payees: [], allow_any_payee: false }]) {
        expect(() => payeeSelection(args)).toThrow(/^open_tab refused: no payees, and allow_any_payee is not true\. An empty or absent payee list does not mean anyone\./);
      }
    });

    it("opens with no allowlist only on an explicit allow_any_payee: true", () => {
      expect(payeeSelection({ allow_any_payee: true })).toEqual({ payees: null, allowAnyPayee: true });
      expect(payeeSelection({ allow_any_payee: true, payees: [] })).toEqual({ payees: null, allowAnyPayee: true });
      expect(() => payeeSelection({ allow_any_payee: true, payees: [G1] })).toThrow(/contradict/);
    });

    it("takes G and C addresses, and refuses muxed, malformed, duplicate and oversized lists", () => {
      expect(payeeSelection({ payees: [G1, ACCOUNT] })).toEqual({ payees: [G1, ACCOUNT], allowAnyPayee: false });

      const muxed = new MuxedAccount(new Account(G1, "0"), "7").accountId();
      expect(() => payeeSelection({ payees: [muxed] })).toThrow(/muxed/);
      expect(() => payeeSelection({ payees: ["GABC"] })).toThrow(/is not a Stellar account/);
      expect(() => payeeSelection({ payees: [G1, G2, G1] })).toThrow(/listed twice/);
      expect(() => payeeSelection({ payees: Array.from({ length: MAX_PAYEES + 1 }, () => Keypair.random().publicKey()) })).toThrow(/at most 20/);
    });

    it("reports a restricted tab from the chain's list, not the stored one", async () => {
      const dir2 = mkdtempSync(join(tmpdir(), "barkeep-payees-"));
      const store2 = new Store(dir2);
      const restricted: Tab = { ...tab, tabId: "tab_payees01", payees: [G1], payeeEnforcement: "on-chain", allowAnyPayee: false };
      store2.putTab(restricted);
      store2.appendReceipt({ tabId: restricted.tabId, at: "1", kind: "open", tx: "open-tx", allowAnyPayee: false });

      // The human signer added G2 after open_tab.
      const status = await tabStatus(chainAt(1284, { policies: ["C_POLICY", "C_ALLOWLIST"], payees: [G1, G2] }), store2, cfg, restricted.tabId);
      expect(status.allow_any_payee).toBe(false);
      expect(status.payees).toBe(describePayees({ payeeEnforcement: "on-chain", payees: [G1, G2], allowAnyPayee: false }));
      expect(status.payees).toMatch(/^Restricted on chain to: .*#3901.*only the human signer/);
      expect(status.receipts).toEqual([{ at: "1", kind: "open", tx: "open-tx", allow_any_payee: false }]);
      expect(status.warnings).toBeUndefined();

      // The record says restricted and the chain disagrees: the chain wins, loudly.
      const gone = await tabStatus(chainAt(1284, { policies: ["C_POLICY"] }), store2, cfg, restricted.tabId);
      expect(gone.allow_any_payee).toBe(true);
      expect(gone.warnings).toEqual([expect.stringMatching(/has no payee allowlist: it can pay anyone/)]);
      rmSync(dir2, { recursive: true, force: true });
    });

    it("puts allow_any_payee on a receipt that recorded it, whatever the tab", () => {
      expect(reportReceipt({ tabId: "t", at: "1", kind: "payment", allowAnyPayee: false }, cfg)).toEqual({ at: "1", kind: "payment", allow_any_payee: false });
    });
  });
});

describe("pay_and_fetch output", () => {
  const base = {
    tab_id: "tab_1", url: "http://127.0.0.1:4021/haiku", http_status: 200, paid: true, replayed: false,
    amount: "0.0001 TAB", token: "TAB, a test asset.", pay_to: "GSELLER", tx: "tx1", explorer: "https://x/tx1",
    body: "line one\nline two", body_truncated: false,
  };

  it("drops the fields that only matter when unusual", () => {
    const { summary, body } = presentPayResult(base);

    expect(Object.keys(summary)).toEqual(["tab_id", "url", "paid", "amount", "token", "pay_to", "tx", "explorer"]);
    expect(body).toBe("line one\nline two");
  });

  it("says so when a call was replayed, when the body was cut off, and when the status was not 2xx", () => {
    const { summary } = presentPayResult({ ...base, replayed: true, body_truncated: true });
    expect(summary).toMatchObject({ replayed: true, body_truncated: true, note: expect.stringMatching(/^No new payment was made/) });

    const free = presentPayResult({ ...base, paid: false, http_status: 404, amount: undefined, tx: undefined, explorer: undefined, pay_to: undefined });
    expect(free.summary).toEqual({ tab_id: "tab_1", url: base.url, paid: false, http_status: 404, token: base.token });
  });
});
