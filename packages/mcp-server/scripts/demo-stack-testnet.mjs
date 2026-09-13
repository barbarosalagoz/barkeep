/*
 * Smoke test for the demo stack, exactly as it runs for a recording:
 *
 *   bin/barkeep-mcp (keys from the Stellar CLI store, over stdio)
 *     -> pay_and_fetch -> src/seller.ts (persistent seller, already running)
 *       -> src/facilitator.ts (its own key, already running) -> Testnet
 *
 * Start the two services first, then run this. It needs no secrets itself:
 * the wrapper reads them, as it does for Claude Code.
 *
 *   BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-facilitator) \
 *     npx tsx packages/mcp-server/src/facilitator.ts &
 *   BARKEEP_SELLER_SECRET=$(stellar keys secret barkeep-testnet-seller) \
 *     npx tsx packages/mcp-server/src/seller.ts &
 *   npx tsx packages/mcp-server/scripts/demo-stack-testnet.mjs
 *
 * Checks: every settlement is submitted by the facilitator's key and not the
 * deployer's; two different paid URLs requested at once both settle (the
 * facilitator serialises settlements); the per-call cap refuses an over-priced
 * route before signing; tab_status and the receipts agree with the chain.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadDeployment } from "../src/deployment.ts";

const SELLER = process.env.BARKEEP_SELLER_URL ?? "http://127.0.0.1:4021";
const wrapper = fileURLToPath(new URL("../bin/barkeep-mcp", import.meta.url));
const deployment = loadDeployment();

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

const info = await (await fetch(`${SELLER}/`)).json();
const supported = await (await fetch(`${info.facilitator}/supported`)).json();
const facilitatorKey = supported.signers["stellar:*"][0];

console.log(`seller       ${SELLER}  payTo ${info.payTo}`);
console.log(`facilitator  ${info.facilitator}  signer ${facilitatorKey}`);
check(facilitatorKey !== deployment.deployer, "the facilitator's signer is not the deployer key", `deployer ${deployment.deployer}`);

const transport = new StdioClientTransport({
  command: wrapper,
  env: { ...process.env, BARKEEP_STATE_DIR: mkdtempSync(join(tmpdir(), "barkeep-demo-stack-")) },
  stderr: "inherit",
});
const client = new Client({ name: "barkeep-demo-stack", version: "0" });
await client.connect(transport);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const body = r.content?.[0]?.text ?? "";
  return r.isError ? { error: body } : JSON.parse(body);
};

const horizonSource = async (hash) =>
  (await (await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`)).json()).source_account;

const { tools } = await client.listTools();
check(tools.length === 4, "the wrapper starts the server and it lists four tools", tools.map((t) => t.name).join(", "));

const tab = await call("open_tab", { limit: "0.001", window: "PT1H" });
if (tab.error) throw new Error(tab.error);
console.log(`\ntab ${tab.tab_id}, rule ${tab.context_rule_id}, cap 0.001, PT1H\n  ${tab.explorer}`);

try {
  const haiku = await call("pay_and_fetch", { url: `${SELLER}/haiku`, max_amount: "0.001" });
  check(haiku.paid === true, "pays /haiku", `${haiku.error ?? haiku.amount} ${haiku.explorer ?? ""}\n        body: ${JSON.stringify(haiku.body)}`);
  if (haiku.tx) {
    const src = await horizonSource(haiku.tx);
    check(src === facilitatorKey, "the settlement was submitted by the facilitator's own key", `source ${src}`);
  }

  const [forecast, haiku2] = await Promise.all([
    call("pay_and_fetch", { url: `${SELLER}/forecast`, max_amount: "0.001" }),
    call("pay_and_fetch", { url: `${SELLER}/haiku`, max_amount: "0.001", request_id: "second-haiku" }),
  ]);
  check(
    forecast.paid === true && haiku2.paid === true && forecast.tx !== haiku2.tx,
    "two different paid URLs at once both settle",
    `${forecast.error ?? forecast.tx}\n        ${haiku2.error ?? haiku2.tx}`
  );

  const dataset = await call("pay_and_fetch", { url: `${SELLER}/dataset`, max_amount: "0.001" });
  check(Boolean(dataset.error) && /exceeds max_amount.*Nothing was signed/.test(dataset.error), "an over-priced route is refused by the per-call cap", dataset.error);

  const status = await call("tab_status", { tab_id: tab.tab_id });
  const payments = status.receipts.filter((r) => r.kind === "payment");
  check(status.spent === "0.00045", "tab_status: 0.0001 + 0.00025 + 0.0001 spent, read from the chain", `spent ${status.spent}, remaining ${status.remaining}`);
  check(payments.length === 3 && payments.every((r) => r.tx && r.endpoint && r.at && r.amount), "three receipts with tx, endpoint, timestamp, amount");
} finally {
  const closed = await call("close_tab", { tab_id: tab.tab_id });
  console.log(`\nclose_tab ${closed.error ?? `final spent ${closed.final_spent}\n  ${closed.explorer}`}`);
  if (closed.tx) {
    const src = await horizonSource(closed.tx);
    check(src === deployment.deployer, "close_tab was submitted by the deployer, not the facilitator", `source ${src}`);
  }
  await client.close();
}

console.log(`\n${pass}/${pass + fail} as expected`);
process.exit(fail === 0 ? 0 : 1);
