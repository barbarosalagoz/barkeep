import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createServer } from "./index.ts";
import { Store, storedText } from "./state.ts";

/*
 * Item 10's done-test: the four tools list, and state survives a restart.
 *
 * These run offline. Nothing here signs or touches the network: the server is
 * constructed, connected over an in-memory transport, and asked what it
 * offers. The on-chain behaviour is proved by tab-lifecycle-testnet.mjs and
 * the item 11/13 runs, which are live and stay out of CI (§11).
 */

const dirs: string[] = [];
const tmpState = () => {
  const dir = mkdtempSync(join(tmpdir(), "barkeep-state-"));
  dirs.push(dir);
  return dir;
};

async function connected() {
  const server = createServer();
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the server as a host sees it", () => {
  beforeAll(() => {
    process.env.BARKEEP_STATE_DIR = tmpState();
  });

  it("starts and lists four tools without any secret in the environment", async () => {
    for (const name of ["BARKEEP_ADMIN_SECRET", "BARKEEP_AGENT_SECRET", "BARKEEP_SUBMITTER_SECRET"]) {
      expect(process.env[name]).toBeUndefined();
    }

    const { client } = await connected();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_tab",
      "open_tab",
      "pay_and_fetch",
      "tab_status",
    ]);
  });

  /*
   * The money tools must force a decision on every call: an allow-rule does not
   * skip requiresUserInteraction and it still prompts under bypass-permissions.
   * tab_status is a read and deliberately does not carry it.
   */
  it("marks the money tools as requiring user interaction", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const flagged = (name: string) =>
      tools.find((t) => t.name === name)?._meta?.["anthropic/requiresUserInteraction"];

    expect(flagged("open_tab")).toBe(true);
    expect(flagged("pay_and_fetch")).toBe(true);
    expect(flagged("close_tab")).toBe(true);
    expect(flagged("tab_status")).toBeUndefined();
  });

  it("declares payees as enforced on chain, and allow_any_payee as the only way to skip them", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const openTab = tools.find((t) => t.name === "open_tab")!;
    const props = openTab.inputSchema.properties as Record<string, { description?: string; type?: string }>;

    expect(props.payees.description).toMatch(/Enforced on chain/);
    expect(props.allow_any_payee.type).toBe("boolean");
    expect(props.allow_any_payee.description).toMatch(/ANY address/);
    expect(openTab.description).toMatch(/no list does not mean anyone/);
    expect(openTab.description).toMatch(/only the human signer can change the list/);
    // Neither is schema-required: the refusal, with its explanation, is open_tab's.
    expect((openTab.inputSchema.required as string[]).sort()).toEqual(["limit", "window"]);
  });

  it("refuses a tab with no payees and no allow_any_payee before touching the network or a key", async () => {
    const { client } = await connected();
    const result = await client.callTool({ name: "open_tab", arguments: { limit: "0.001", window: "PT10M" } });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/open_tab refused: no payees, and allow_any_payee is not true/);
  });

  /*
   * The description is what the agent reads. It must not let anyone believe
   * Barkeep pays any x402 endpoint: the public facilitator refuses
   * smart-account payers (deployments/testnet.json, doneTests.x402Spike).
   */
  it("says plainly that pay_and_fetch does not pay arbitrary x402 endpoints, and why", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    const pay = tools.find((t) => t.name === "pay_and_fetch")!;

    expect(pay.description).toMatch(/does NOT pay arbitrary x402 endpoints/);
    expect(pay.description).toMatch(/facilitator accepts smart-account payers/);
    expect(pay.description).toMatch(/event check/);
    expect((pay.inputSchema.required as string[]).sort()).toEqual(["max_amount", "url"]);
  });

  it("refuses to pay without an open tab, before touching the network", async () => {
    const { client } = await connected();
    const result = await client.callTool({
      name: "pay_and_fetch",
      arguments: { url: "http://127.0.0.1:9/never", max_amount: "0.1" },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/no open tab/);
  });
});

describe("state", () => {
  it("survives a restart", () => {
    const dir = tmpState();
    const tab = {
      tabId: "tab_restart01",
      contextRuleId: 42,
      policyContract: "C_POLICY",
      token: "C_TOKEN",
      limit: "5000",
      windowLedgers: 720,
      expiryLedger: 1234,
      agentPublicKey: "GAGENT",
      payees: null,
      payeeEnforcement: "none" as const,
      status: "open" as const,
      openedAt: "2026-09-12T00:00:00.000Z",
      openTx: "abc123",
    };

    // First run.
    const first = new Store(dir);
    first.putTab(tab);
    first.appendReceipt({ tabId: tab.tabId, at: tab.openedAt, kind: "open", tx: tab.openTx });

    // A second process, same directory: a new Store reads from disk only.
    const second = new Store(dir);

    expect(second.getTab("tab_restart01")).toEqual(tab);
    expect(second.currentTab()?.tabId).toBe("tab_restart01");
    expect(second.receipts("tab_restart01")).toHaveLength(1);
  });

  it("keeps the receipt log append-only", () => {
    const dir = tmpState();
    const store = new Store(dir);

    store.appendReceipt({ tabId: "t", at: "1", kind: "open" });
    store.appendReceipt({ tabId: "t", at: "2", kind: "close" });
    new Store(dir).appendReceipt({ tabId: "t", at: "3", kind: "payment", amount: "1" });

    const lines = readFileSync(join(dir, "receipts.jsonl"), "utf8").trim().split("\n");

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).at)).toEqual(["1", "2", "3"]);
  });

  /*
   * The state directory must never hold key material. This checks the real
   * files after a realistic write, not a mock: a Stellar secret is a 56-char
   * base32 string starting with S, which is cheap to spot.
   */
  it("holds no key material", () => {
    const dir = tmpState();
    const store = new Store(dir);

    store.putTab({
      tabId: "tab_clean01",
      contextRuleId: 1,
      policyContract: "C_POLICY",
      token: "C_TOKEN",
      limit: "1",
      windowLedgers: 1,
      expiryLedger: 1,
      agentPublicKey: "GDUQYLCSWA3CTGCK7XHAW622QRX54Q3FZQWOYUICUNLZZQOHCOXQD5TS",
      payees: null,
      payeeEnforcement: "none",
      status: "open",
      openedAt: "2026-09-12T00:00:00.000Z",
      openTx: "abc",
    });
    store.appendReceipt({ tabId: "tab_clean01", at: "1", kind: "open", tx: "abc" });

    const written = storedText(dir);

    // A Stellar secret seed: 56 chars of base32 starting with S.
    expect(written).not.toMatch(/\bS[A-Z2-7]{55}\b/);
    expect(written).not.toMatch(/secret|private|seed|mnemonic/i);
    // The agent is referenced by its PUBLIC key, which is the point.
    expect(written).toContain("GDUQYLCSWA3CTGCK7XHAW622QRX54Q3FZQWOYUICUNLZZQOHCOXQD5TS");
  });
});
