/*
 * Done-tests for items 11, 12 and 13, against the live Testnet deployment.
 *
 * Drives the real MCP tools through a real client over an in-memory transport
 * -- the same code path a host uses, not a private back door -- and proves:
 *
 *   11. open_tab creates the agent rule on chain and returns a tab id + tx
 *   12. tab_status reflects a transfer made OUTSIDE the server
 *   13. close_tab revokes the agent key: it can no longer transfer
 *
 * 12 and 13 are the ones that matter. Local bookkeeping would pass 12 while
 * being wrong, and a close that only marks a record "closed" would pass 13
 * while the key still spends.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   npx tsx scripts/tab-tools-testnet.mjs
 *
 * Secrets come from the environment and are never written anywhere.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Address, Keypair, nativeToScVal } from "@stellar/stellar-sdk";

import { Chain, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";
import { createServer } from "../src/index.ts";

process.env.BARKEEP_STATE_DIR ??= mkdtempSync(join(tmpdir(), "barkeep-live-"));

const deployment = loadDeployment();
const C = deployment.contracts;

/*
 * open_tab and close_tab read BARKEEP_ADMIN_SECRET themselves; this script only
 * needs the agent key, to spend outside the server, and the submitter, to pay
 * the fee.
 */
const agent = Keypair.fromSecret(process.env.BARKEEP_AGENT_SECRET);
const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET);

const chain = new Chain(
  {
    rpcUrl: deployment.rpcUrl,
    networkPassphrase: deployment.networkPassphrase,
    smartAccount: C.smartAccount.id,
    verifierEd25519: C.verifierEd25519.id,
  },
  submitter
);

const server = createServer();
const client = new Client({ name: "barkeep-done-test", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const body = r.content?.[0]?.text ?? "";
  if (r.isError) throw new Error(`${name}: ${body}`);
  return JSON.parse(body);
};

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

console.log(`state dir ${process.env.BARKEEP_STATE_DIR}`);
console.log(`account   ${C.smartAccount.id}\n`);

/* ---- 11. open_tab -------------------------------------------------------- */
console.log("11. open_tab");

try {
  await call("open_tab", { limit: "0.001", window: "PT10M", payees: ["GABC"] });
  check(false, "passing payees is refused");
} catch (e) {
  check(/not enforceable yet/.test(String(e)), "passing payees is refused, not silently ignored");
}

const LIMIT = "0.0005";        // 5000 base units at 7 decimals
const opened = await call("open_tab", { limit: LIMIT, window: "PT1M" });

check(Boolean(opened.tab_id && opened.tx), "creates the rule on chain and returns a tab id + tx",
  `tab ${opened.tab_id}  rule ${opened.context_rule_id}\n        tx ${opened.explorer}`);
check(opened.payee_enforcement === "none", "reports that payees are not enforced");

/* ---- 12. tab_status matches the chain ------------------------------------ */
console.log("\n12. tab_status");

const before = await call("tab_status", { tab_id: opened.tab_id });
check(before.spent === "0", "starts at zero spent", `limit ${before.limit}, spent ${before.spent}`);
check(before.source === "chain", "reports the chain as its source");
check(
  before.constraints.payees.enforced === false && before.warnings.some((w) => /not WHO TO/.test(w)),
  "states plainly that payees are unconstrained"
);

/*
 * Spend OUTSIDE the server: this transfer is built and signed here, by the same
 * agent key, and the server is never told. If tab_status kept its own tally it
 * would still say 0.
 */
const OUTSIDE = 2000n;
console.log(`\n  spending ${OUTSIDE} base units outside the server...`);

const transfer = await chain.send(
  {
    contract: C.token.id,
    fn: "transfer",
    args: [
      new Address(C.smartAccount.id).toScVal(),
      new Address(deployment.deployer).toScVal(),
      nativeToScVal(OUTSIDE, { type: "i128" }),
    ],
  },
  { signWith: agent, contextRuleId: opened.context_rule_id }
);

check(transfer.ok, "the out-of-band transfer succeeded", transfer.hash ? explorerTx(transfer.hash) : "");

const after = await call("tab_status", { tab_id: opened.tab_id });
const expected = (Number(LIMIT) * 1e7 - Number(OUTSIDE)) / 1e7;

check(
  after.spent === "0.0002",
  "tab_status reflects spending the server never saw",
  `spent ${before.spent} -> ${after.spent}, remaining ${after.remaining} (expected ${expected})`
);
check(Number(after.remaining) === expected, "remaining is limit minus on-chain spend");

/* ---- 13. close_tab revokes the key --------------------------------------- */
console.log("\n13. close_tab");

const closed = await call("close_tab", { tab_id: opened.tab_id });
check(Boolean(closed.tx), "removes the context rule", `tx ${closed.explorer}`);

/*
 * The proof: the same agent key, the same transfer, well within the cap and
 * before the expiry. It must now be refused because the rule is gone.
 */
const afterClose = await chain.send(
  {
    contract: C.token.id,
    fn: "transfer",
    args: [
      new Address(C.smartAccount.id).toScVal(),
      new Address(deployment.deployer).toScVal(),
      nativeToScVal(100n, { type: "i128" }),
    ],
  },
  {
    signWith: agent,
    contextRuleId: opened.context_rule_id,
    force: transfer.footprint
      ? { sorobanData: transfer.footprint.sorobanData, fee: String(Number(transfer.footprint.fee) * 4) }
      : undefined,
  }
);

const code = (afterClose.error ?? "").match(/Error\(Contract, #(\d+)\)/)?.[1];

/*
 * 3000 is ContextRuleNotFound: the rule is gone, so there is nothing to look
 * up. That is a different refusal from an expired tab, which gives 3002
 * (UnvalidatedContext) because the rule is still there and no longer valid.
 */
check(
  !afterClose.ok && code === "3000",
  "the agent key can no longer transfer",
  `${afterClose.hash ? `tx ${explorerTx(afterClose.hash)}\n        ` : ""}on-chain error: Error(Contract, #${code ?? "?"}) (expect 3000 ContextRuleNotFound)`
);

console.log(`\n${pass}/${pass + fail} as expected`);
process.exit(fail === 0 ? 0 : 1);
