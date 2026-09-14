import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { readPayees, readSpend } from "./read.ts";
import type { ChainRead, Invocation } from "./reader.ts";
import { PAYEES_NOT_RESTRICTED, allowsAnyPayee, describePayees, reportReceipt } from "./receipts.ts";

/*
 * The reads, against a chain that answers the three calls a tab needs. What
 * is pinned: which contract and function each read asks, with which args, and
 * that the allowlist is only read when the rule carries it.
 */

const ACCOUNT = "CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH";
const SPENDING = "CBEILTNYZEE5KX6WTSRON3FCXE7KBYAAUVUWY7TWEUBIEHIY47NVPWBZ";
const ALLOWLIST = "CD6Z4IAZ7MIGW2J2SZ545GN7CSRZY52HFFWUT3FUADHYRN7Z47N73IIY";
const G1 = "GA3UUMEFLK3AXZZ5G77RE77DEKQJPBH5UIXQNW6JSHUUB3G3UPUYRB5U";

const cfg = { smartAccount: ACCOUNT, payeeAllowlistPolicy: ALLOWLIST };

function chain(policies: string[], payees: string[] = []): ChainRead & { asked: Invocation[] } {
  const asked: Invocation[] = [];
  return {
    asked,
    async read(inv) {
      asked.push(inv);
      if (inv.fn === "get_spending_limit_data") return { spending_limit: 5000n, period_ledgers: 720, cached_total_spent: 1000n };
      if (inv.fn === "get_context_rule") return { id: 28, policies };
      if (inv.fn === "get_payees") return payees;
      throw new Error(`unexpected read ${inv.fn}`);
    },
  };
}

describe("readSpend", () => {
  it("asks the tab's spending-limit policy for the rule's data, keyed by the account", async () => {
    const c = chain([SPENDING]);
    const spend = await readSpend(c, cfg, { policyContract: SPENDING, contextRuleId: 28 });

    expect(spend).toEqual({ limit: 5000n, spent: 1000n, periodLedgers: 720 });
    expect(c.asked).toHaveLength(1);
    expect(c.asked[0]).toMatchObject({ contract: SPENDING, fn: "get_spending_limit_data" });
    expect(c.asked[0].args[0].u32()).toBe(28);
    expect(c.asked[0].args[1].switch()).toBe(xdr.ScValType.scvAddress());
  });
});

describe("readPayees", () => {
  it("reports allow-any without reading the allowlist when the rule does not carry it", async () => {
    const c = chain([SPENDING]);
    expect(await readPayees(c, cfg, { contextRuleId: 28 })).toEqual({ allowAnyPayee: true, payees: null });
    expect(c.asked.map((i) => i.fn)).toEqual(["get_context_rule"]);
  });

  it("reads the list from the policy when the rule carries it", async () => {
    const c = chain([SPENDING, ALLOWLIST], [G1]);
    expect(await readPayees(c, cfg, { contextRuleId: 28 })).toEqual({ allowAnyPayee: false, payees: [G1] });
    expect(c.asked.map((i) => `${i.contract === ALLOWLIST ? "allowlist" : "account"}.${i.fn}`)).toEqual([
      "account.get_context_rule",
      "allowlist.get_payees",
    ]);
  });
});

describe("presentation", () => {
  it("treats a tab from before the allowlist as allow-any, and a restricted one as restricted", () => {
    expect(allowsAnyPayee({ payeeEnforcement: "none" })).toBe(true);
    expect(allowsAnyPayee({ payeeEnforcement: "on-chain", allowAnyPayee: false })).toBe(false);
    expect(describePayees({ payeeEnforcement: "none", payees: null })).toBe(PAYEES_NOT_RESTRICTED);
    expect(describePayees({ payeeEnforcement: "on-chain", payees: [G1], allowAnyPayee: false })).toMatch(/^Restricted on chain to: G.*#3901/);
  });

  it("reports a receipt line in snake_case with the amount's symbol and the payee flag", () => {
    const line = reportReceipt(
      { tabId: "t", at: "1", kind: "refused", amount: "0.0001", endpoint: "/x", to: G1, refusedBy: "on-chain policy", reason: "#3901" },
      { tokenSymbol: "TAB" },
      { payeeEnforcement: "on-chain", allowAnyPayee: false }
    );
    expect(line).toEqual({ at: "1", kind: "refused", amount: "0.0001 TAB", endpoint: "/x", to: G1, refused_by: "on-chain policy", reason: "#3901", allow_any_payee: false });
    expect(reportReceipt({ tabId: "t", at: "2", kind: "open", tx: "h" }, { tokenSymbol: "TAB" })).toEqual({ at: "2", kind: "open", tx: "h" });
  });
});
