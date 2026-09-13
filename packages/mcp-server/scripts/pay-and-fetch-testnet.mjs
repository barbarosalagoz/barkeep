/*
 * Done-tests for pay_and_fetch, against the live Testnet deployment.
 *
 * Drives the real MCP tools through a real client over an in-memory transport,
 * paying a seller stood up here whose facilitator is Barkeep's own
 * (src/facilitator.ts), served over HTTP and reached through @x402/core's
 * HTTPFacilitatorClient -- the same wire a third-party seller would use.
 *
 *   P1  a payment succeeds, and shows in tab_status (spent, from the chain)
 *       and in the receipts
 *   P2  a payment over the tab's REMAINING cap is refused by the policy:
 *       pay_and_fetch stops at the enforcing simulation with #3221 and sends
 *       nothing to the seller; the same transfer, forced onto the ledger with
 *       the settled payment's footprint, is refused on chain with #3221
 *   P3  two identical calls produce one transaction, sequentially and
 *       concurrently
 *
 * Why P2 needs the forced submission: under x402 the facilitator submits, and
 * both our client and the facilitator simulate first, so an over-cap payment
 * never reaches the ledger through pay_and_fetch at all. The forced transfer
 * is the same invocation (account, token, seller, amount, rule, agent key),
 * submitted directly so the chain's refusal has a hash.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-facilitator) \
 *   npx tsx scripts/pay-and-fetch-testnet.mjs
 *
 * The facilitator pays settlement fees with its own key, never the deployer's
 * that open_tab and close_tab submit with. Secrets come from the environment
 * and are never written anywhere; the seller is a fresh throwaway.
 */
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Address, Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder, nativeToScVal,
} from "@stellar/stellar-sdk";
import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { Chain, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";
import { createFacilitator, facilitatorListener } from "../src/facilitator.ts";
import { createServer } from "../src/index.ts";

process.env.BARKEEP_STATE_DIR ??= mkdtempSync(join(tmpdir(), "barkeep-pay-live-"));

const deployment = loadDeployment();
const C = deployment.contracts;
const NET = deployment.networkPassphrase;
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const agent = Keypair.fromSecret(process.env.BARKEEP_AGENT_SECRET);
const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET);
const facilitatorKp = Keypair.fromSecret(process.env.BARKEEP_FACILITATOR_SECRET);
if (facilitatorKp.publicKey() === submitter.publicKey()) throw new Error("the facilitator must not share the submitter's key");

const chain = new Chain(
  { rpcUrl: deployment.rpcUrl, networkPassphrase: NET, smartAccount: C.smartAccount.id, verifierEd25519: C.verifierEd25519.id },
  submitter
);

let pass = 0;
let fail = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));

/* ---- Barkeep's facilitator, over HTTP ------------------------------------ */

const facilitatorUrl = await listen(createHttpServer(facilitatorListener(createFacilitator(facilitatorKp.secret()))));

/* ---- a seller: fresh account, TAB trustline, two priced routes ----------- */

const sellerKp = Keypair.random();
await fetch(`https://friendbot.stellar.org?addr=${sellerKp.publicKey()}`);
{
  const acct = await horizon.loadAccount(sellerKp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.changeTrust({ asset: new Asset("TAB", deployment.deployer) }))
    .setTimeout(60)
    .build();
  tx.sign(sellerKp);
  await horizon.submitTransaction(tx);
}

const PRICES = { "/cheap": "1000", "/dear": "4500" }; // base units; tab cap is 5000
const sellerLog = { signatures: {}, settles: [] };
const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

const sellerUrl = await listen(
  createHttpServer(async (req, res) => {
    const price = PRICES[req.url];
    if (!price) return res.writeHead(404).end();

    const requirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: C.token.id,
      amount: price,
      payTo: sellerKp.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    };

    const sig = req.headers["payment-signature"];
    if (!sig) {
      const required = { x402Version: 2, resource: { url: `http://${req.headers.host}${req.url}` }, accepts: [requirements] };
      return res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }).end("{}");
    }

    sellerLog.signatures[req.url] = (sellerLog.signatures[req.url] ?? 0) + 1;
    const payload = decodePaymentSignatureHeader(sig);
    const verify = await facilitator.verify(payload, requirements);
    if (!verify.isValid) {
      return res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: verify.invalidReason }));
    }

    const settle = await facilitator.settle(payload, requirements);
    sellerLog.settles.push({ route: req.url, success: settle.success, tx: settle.transaction });
    if (!settle.success) {
      return res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: settle.errorReason }));
    }

    res
      .writeHead(200, { "content-type": "text/plain", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) })
      .end(`the paid resource at ${req.url}`);
  })
);

/* ---- the MCP server, as a host sees it ----------------------------------- */

const server = createServer();
const client = new Client({ name: "barkeep-pay-done-test", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const body = r.content?.[0]?.text ?? "";
  return r.isError ? { error: body } : JSON.parse(body);
};

console.log(`state dir    ${process.env.BARKEEP_STATE_DIR}`);
console.log(`account      ${C.smartAccount.id}`);
console.log(`facilitator  ${facilitatorUrl} (fee payer ${facilitatorKp.publicKey()})`);
console.log(`seller       ${sellerUrl} (payTo ${sellerKp.publicKey()})\n`);

const opened = await call("open_tab", { limit: "0.0005", window: "PT15M" });
if (opened.error) throw new Error(opened.error);
console.log(`tab ${opened.tab_id}, rule ${opened.context_rule_id}, cap 0.0005\n  ${opened.explorer}\n`);

try {
  /* ---- P1 ---------------------------------------------------------------- */
  console.log("P1  a payment succeeds and appears in tab_status and the receipts");

  const p1 = await call("pay_and_fetch", { url: `${sellerUrl}/cheap`, max_amount: "0.001" });
  check(p1.paid === true && Boolean(p1.tx), "pay_and_fetch paid and returned the resource",
    `${p1.error ?? `${p1.amount} to ${p1.pay_to}, body "${p1.body}"`}\n        ${p1.explorer ?? ""}`);

  const s1 = await call("tab_status", { tab_id: opened.tab_id });
  check(s1.spent === "0.0001", "tab_status shows the spend, read from the policy on chain", `spent ${s1.spent}, remaining ${s1.remaining}`);

  const receipt = s1.receipts?.find((r) => r.kind === "payment" && r.tx === p1.tx);
  check(
    Boolean(receipt && receipt.amount === "0.0001" && receipt.endpoint === `${sellerUrl}/cheap` && receipt.at && receipt.tabId === opened.tab_id),
    "the receipt log has tx, amount, endpoint, timestamp and tab id",
    JSON.stringify(receipt)
  );

  /* ---- P3 ---------------------------------------------------------------- */
  console.log("\nP3  identical calls produce one transaction");

  const again = await call("pay_and_fetch", { url: `${sellerUrl}/cheap`, max_amount: "0.001" });
  check(again.replayed === true && again.tx === p1.tx, "a repeat of P1's call returns P1's transaction", `tx ${again.tx}, replayed ${again.replayed}`);

  const [c1, c2] = await Promise.all([
    call("pay_and_fetch", { url: `${sellerUrl}/cheap`, max_amount: "0.001", request_id: "concurrent" }),
    call("pay_and_fetch", { url: `${sellerUrl}/cheap`, max_amount: "0.001", request_id: "concurrent" }),
  ]);
  check(c1.tx && c1.tx === c2.tx && c1.tx !== p1.tx, "two identical concurrent calls share one new transaction",
    `${c1.error ?? c1.tx} / ${c2.error ?? c2.tx}\n        ${c1.explorer ?? ""}`);

  check(sellerLog.signatures["/cheap"] === 2 && sellerLog.settles.length === 2,
    "the seller received exactly two payment signatures for four calls",
    `signatures ${sellerLog.signatures["/cheap"]}, settlements ${JSON.stringify(sellerLog.settles)}`);

  const s3 = await call("tab_status", { tab_id: opened.tab_id });
  check(s3.spent === "0.0002", "the chain agrees: two transfers of 0.0001", `spent ${s3.spent}, remaining ${s3.remaining}`);
  check(s3.receipts.filter((r) => r.kind === "payment").length === 2, "and the receipt log has two payments, not four");

  /* ---- P2 ---------------------------------------------------------------- */
  console.log("\nP2  a payment over the tab's remaining cap is refused");

  const p2 = await call("pay_and_fetch", { url: `${sellerUrl}/dear`, max_amount: "0.001" });
  check(Boolean(p2.error) && /#3221/.test(p2.error), "pay_and_fetch is refused by the spending-limit policy (#3221)",
    `price 0.00045 <= max_amount 0.001, remaining ${s3.remaining}\n        ${p2.error}`);
  check(!sellerLog.signatures["/dear"], "nothing was sent to the seller");

  const donor = await chain.server.getTransaction(p1.tx);
  const donorTx = TransactionBuilder.fromXDR(donor.envelopeXdr, NET);
  const forced = await chain.send(
    {
      contract: C.token.id,
      fn: "transfer",
      args: [
        new Address(C.smartAccount.id).toScVal(),
        new Address(sellerKp.publicKey()).toScVal(),
        nativeToScVal(4500n, { type: "i128" }),
      ],
    },
    {
      signWith: agent,
      contextRuleId: opened.context_rule_id,
      force: { sorobanData: donorTx.toEnvelope().v1().tx().ext().sorobanData(), fee: String(Number(donorTx.fee) * 4) },
    }
  );
  check(!forced.ok && forced.stage === "execution" && Boolean(forced.hash) && /#3221/.test(forced.error ?? ""),
    "the same transfer, forced onto the ledger, is refused on chain",
    `${forced.hash ? explorerTx(forced.hash) : forced.stage}\n        ${forced.error}`);

  const s2 = await call("tab_status", { tab_id: opened.tab_id });
  check(s2.spent === "0.0002", "spend is unchanged by the refusal", `spent ${s2.spent}`);
} finally {
  const closed = await call("close_tab", { tab_id: opened.tab_id });
  console.log(`\nclose_tab ${closed.error ?? `final spent ${closed.final_spent}\n  ${closed.explorer}`}`);
}

console.log(`\n${pass}/${pass + fail} as expected`);
process.exit(fail === 0 ? 0 : 1);
