import { Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import type { Chain } from "./chain.ts";
import { describeOtherRules } from "./index.ts";
import { rawEd25519Key } from "./keys.ts";
import { describeExpiry, describeWindow, ledgersToWindow, rulesListingKey, withUnit } from "./tabs.ts";

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

describe("amounts", () => {
  it("always carry the token symbol", () => {
    expect(withUnit(1000n, { tokenDecimals: 7, tokenSymbol: "TAB" })).toBe("0.0001 TAB");
    expect(withUnit(0n, { tokenDecimals: 7, tokenSymbol: "TAB" })).toBe("0 TAB");
  });
});

describe("time", () => {
  it("shows the window as asked and in ledgers", () => {
    expect(describeWindow("PT1H", 720)).toBe("PT1H (720 ledgers)");
    expect(ledgersToWindow(720)).toBe("PT1H");
    expect(ledgersToWindow(180)).toBe("PT15M");
    expect(ledgersToWindow(17280)).toBe("P1D");
    expect(describeWindow(undefined, 18)).toBe("PT1M30S (18 ledgers)");
  });

  it("shows expiry as a ledger and a rough time", () => {
    expect(describeExpiry(4653477, 4652761)).toBe("at ledger 4653477, in ~60 min (716 ledgers)");
    expect(describeExpiry(100, 112)).toBe("at ledger 100, ~1 min ago (12 ledgers)");
  });
});
