/*
 * Done-tests for the payee-allowlist policy, against the live Testnet deployment.
 *
 * Drives the real MCP tools over an in-memory transport, paying a local seller
 * whose facilitator is Barkeep's own (src/facilitator.ts) over HTTP -- the
 * pay-and-fetch-testnet.mjs setup -- with a tab whose rule carries BOTH the
 * spending-limit policy and the payee allowlist.
 *
 *   A1  a payment to an allowlisted payee succeeds; its transaction carries
 *       no event from the allowlist
 *   A2  a payment to a payee NOT on the list, under the cap, fails: refused at
 *       the enforcing simulation with #3901 (nothing sent to the seller), and
 *       the same transfer forced onto the ledger fails on chain with #3901
 *   A2' a payment to an allowlisted payee OVER the cap fails on chain with
 *       #3221 -- the two policies compose on one rule
 *   A3  the agent key cannot add a payee: add_payee signed by the agent on the
 *       tab's rule fails on chain with #3002; the human signer's add_payee
 *       succeeds, and the payee refused in A2 then pays
 *   A4  a tab with neither payees nor allow_any_payee is refused by open_tab
 *       before anything is signed (no rule is created); an empty list forced
 *       into the contract's install fails on chain with #3902
 *   A5  a tab opened with allow_any_payee: true shows the flag in tab_status
 *       and on every receipt
 *
 * Forced submissions exist for the same reason as in pay-and-fetch-testnet.mjs:
 * both our client and a facilitator simulate first, so a refused payment never
 * reaches the ledger by itself. The forced transaction is the same invocation,
 * submitted directly with a footprint from a successful one, so the chain's
 * refusal has a hash.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-facilitator) \
 *   npx tsx scripts/payee-allowlist-testnet.mjs
 *
 * Secrets come from the environment and are never written anywhere; both
 * sellers are fresh throwaways.
 */
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  Address, Asset, BASE_FEE, Horizon, Keypair, Operation, StrKey, TransactionBuilder, authorizeEntry,
  nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";

import { Chain, contractErrorCode, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";
import { createFacilitator, facilitatorListener } from "../src/facilitator.ts";
import { createServer } from "../src/index.ts";
import { rawEd25519Key } from "../src/keys.ts";
import { Store } from "../src/state.ts";

process.env.BARKEEP_STATE_DIR ??= mkdtempSync(join(tmpdir(), "barkeep-allowlist-live-"));

const deployment = loadDeployment();
const C = deployment.contracts;
const NET = deployment.networkPassphrase;
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const admin = Keypair.fromSecret(process.env.BARKEEP_ADMIN_SECRET);
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

/** Every hash this run puts on the ledger, cross-checked on Horizon at the end. */
const onLedger = [];
const record = (label, hash, expectSuccess) => {
  if (hash) onLedger.push({ label, hash, expectSuccess });
};

/* ---- chain helpers --------------------------------------------------------- */

const addr = (a) => new Address(a).toScVal();
const i128 = (n) => nativeToScVal(n, { type: "i128" });

/** The sorobanData of a transaction already on the ledger, to force a refusal with. */
async function footprintOf(hash) {
  const got = await chain.server.getTransaction(hash);
  const tx = TransactionBuilder.fromXDR(got.envelopeXdr, NET);
  return { sorobanData: tx.toEnvelope().v1().tx().ext().sorobanData(), fee: String(Number(tx.fee) * 4) };
}

/**
 * A4's forced install. The empty-list install fails in simulation, so it has no
 * footprint of its own; a valid install against the same next rule id touches
 * the same keys. One trap: the admin's __check_auth SUCCEEDS here, so the host
 * consumes the auth entry's nonce, and that nonce's ledger entry must be in the
 * footprint or the transaction dies with a storage error before install runs.
 * So both entries carry the same fixed nonce, and the valid one is simulated to
 * produce the footprint the empty one is submitted with.
 */
async function forceWithValidTwin(valid, refused, signWith, contextRuleId) {
  const nonce = BigInt(Math.floor(Math.random() * 2 ** 47));
  const validUntil = (await chain.latestLedger()) + 60;
  const entry = ({ contract, fn, args }) =>
    authorizeEntry(
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
          new xdr.SorobanAddressCredentials({
            address: new Address(C.smartAccount.id).toScAddress(),
            nonce: new xdr.Int64(nonce),
            signatureExpirationLedger: 0,
            signature: xdr.ScVal.scvVoid(),
          })
        ),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({ contractAddress: new Address(contract).toScAddress(), functionName: fn, args })
          ),
          subInvocations: [],
        }),
      }),
      chain.signAs(signWith, contextRuleId),
      validUntil,
      NET
    );
  const build = async ({ contract, fn, args }, auth, sorobanData, fee) => {
    const b = new TransactionBuilder(await chain.server.getAccount(submitter.publicKey()), { fee: fee ?? BASE_FEE, networkPassphrase: NET })
      .addOperation(Operation.invokeContractFunction({ contract, function: fn, args, auth }))
      .setTimeout(60);
    if (sorobanData) b.setSorobanData(sorobanData);
    return b.build();
  };

  const validTx = await build(valid, [await entry(valid)]);
  const sim = await chain.server.simulateTransaction(validTx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`valid twin failed to simulate: ${sim.error}`);
  const assembled = rpc.assembleTransaction(validTx, sim).build();
  const sorobanData = assembled.toEnvelope().v1().tx().ext().sorobanData();

  const tx = await build(refused, [await entry(refused)], sorobanData, String(Number(assembled.fee) * 4));
  tx.sign(submitter);
  const sent = await chain.server.sendTransaction(tx);
  if (sent.status === "ERROR") return { ok: false, stage: "send", hash: sent.hash };
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await chain.server.getTransaction(sent.hash);
    if (got.status !== "NOT_FOUND") return { ok: got.status === "SUCCESS", stage: "execution", hash: sent.hash };
  }
  return { ok: false, stage: "timeout", hash: sent.hash };
}

/** Contract events of a settled transaction, as "emitter topic0", read from RPC. */
async function eventsOf(hash) {
  const got = await chain.server.getTransaction(hash);
  let events = got.events?.contractEventsXdr?.flat();
  if (!events) {
    const meta = got.resultMetaXdr;
    const v = meta.switch();
    events = (v === 4 ? meta.v4().operations().flatMap((op) => op.events()) : meta.v3().sorobanMeta()?.events()) ?? [];
  }
  return events.map((ev) => {
    const emitter = StrKey.encodeContract(ev.contractId());
    const topic = scValToNative(ev.body().v0().topics()[0]);
    return { emitter, topic };
  });
}

async function nextRuleId() {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(C.smartAccount.id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const { entries } = await chain.server.getLedgerEntries(key);
  const wanted = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("NextId")]).toXDR("base64");
  const entry = entries[0].val.contractData().val().instance().storage().find((e) => e.key().toXDR("base64") === wanted);
  return Number(scValToNative(entry.val()));
}

const codeOf = (text) => (text ?? "").match(/Error\(Contract, #(\d+)\)/)?.[1] ?? null;

/**
 * The contract error the LEDGER recorded for a failed transaction, read back
 * from RPC by hash -- not the simulation's message, which a forced submission
 * also carries.
 */
async function ledgerCodeOf(hash) {
  if (!hash) return null;
  const got = await chain.server.getTransaction(hash);
  if (got.status !== "FAILED") return null;
  const code = contractErrorCode(got.diagnosticEventsXdr ?? []);
  return code === null ? null : String(code);
}

/** One line for a forced submission: where it ended, and the ledger's code. */
async function forcedOutcome(result) {
  const code = await ledgerCodeOf(result.hash);
  return {
    code,
    line: `${result.hash ? explorerTx(result.hash) : `not submitted (${result.stage})`}\n        ledger: ${result.stage}, ${code ? `Error(Contract, #${code})` : "no contract error"} (read back from RPC getTransaction)`,
  };
}

/* ---- Barkeep's facilitator, over HTTP -------------------------------------- */

const facilitatorUrl = await listen(createHttpServer(facilitatorListener(createFacilitator(facilitatorKp.secret()))));
const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl });

/* ---- two sellers: both can receive TAB, only one is on the tab's list ------ */

async function freshPayee() {
  const kp = Keypair.random();
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.changeTrust({ asset: new Asset("TAB", deployment.deployer) }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  return kp.publicKey();
}

const listed = await freshPayee();
const unlisted = await freshPayee();

const ROUTES = {
  "/listed": { price: "1000", payTo: listed },
  "/unlisted": { price: "1000", payTo: unlisted },
  "/dear": { price: "4500", payTo: listed },
};
const sellerLog = { signatures: {}, settles: [] };

const sellerUrl = await listen(
  createHttpServer(async (req, res) => {
    const route = ROUTES[req.url];
    if (!route) return res.writeHead(404).end();

    const requirements = {
      scheme: "exact", network: "stellar:testnet", asset: C.token.id, amount: route.price, payTo: route.payTo,
      maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
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
    res.writeHead(200, { "content-type": "text/plain", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) }).end(`paid: ${req.url}`);
  })
);

/* ---- the MCP server, as a host sees it ------------------------------------- */

const server = createServer();
const client = new Client({ name: "barkeep-allowlist-done-test", version: "0" });
const [a, b] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(b), client.connect(a)]);

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) return { error: text };
  return r.content?.[1] ? { ...JSON.parse(text), body: r.content[1].text } : JSON.parse(text);
};

console.log(`state dir    ${process.env.BARKEEP_STATE_DIR}`);
console.log(`account      ${C.smartAccount.id}`);
console.log(`allowlist    ${C.policyPayeeAllowlist.id}`);
console.log(`facilitator  ${facilitatorUrl} (fee payer ${facilitatorKp.publicKey()})`);
console.log(`seller       ${sellerUrl}`);
console.log(`listed       ${listed}`);
console.log(`unlisted     ${unlisted}\n`);

/* ---- A4 (open_tab half): refused before anything is signed ----------------- */
console.log("A4  a tab with neither payees nor allow_any_payee is refused");

const idBefore = await nextRuleId();
const noPayees = await call("open_tab", { limit: "0.0005", window: "PT15M" });
check(/^open_tab refused: no payees, and allow_any_payee is not true/.test(noPayees.error ?? ""),
  "open_tab with no payees and no allow_any_payee is refused", noPayees.error ?? JSON.stringify(noPayees));
const emptyPayees = await call("open_tab", { limit: "0.0005", window: "PT15M", payees: [] });
check(/^open_tab refused: no payees/.test(emptyPayees.error ?? ""), "an empty payees list is refused the same way", emptyPayees.error);
const falseFlag = await call("open_tab", { limit: "0.0005", window: "PT15M", allow_any_payee: false });
check(/^open_tab refused: no payees/.test(falseFlag.error ?? ""), "allow_any_payee: false with no payees is refused", falseFlag.error);
const idAfter = await nextRuleId();
check(idAfter === idBefore, "no context rule was created: the account's NextId is unchanged", `NextId ${idBefore} -> ${idAfter}`);

/* ---- open the restricted tab ----------------------------------------------- */

const opened = await call("open_tab", { limit: "0.0005", window: "PT15M", payees: [listed] });
if (opened.error) throw new Error(opened.error);
record("openTab (restricted)", opened.tx, true);
console.log(`\ntab ${opened.tab_id}, rule ${opened.context_rule_id}, cap 0.0005, payees [${listed}]\n  ${opened.explorer}`);
check(opened.allow_any_payee === false && opened.payees.includes(listed), "open_tab reports the tab as restricted", opened.payees);

const rule = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(opened.context_rule_id)] });
check(rule.policies.includes(C.policySpendingLimit.id) && rule.policies.includes(C.policyPayeeAllowlist.id) && rule.policies.length === 2,
  "the rule on chain carries both policies", `policies ${rule.policies.join(", ")}`);

let closedRestricted = false;
try {
  /* ---- A1 ------------------------------------------------------------------ */
  console.log("\nA1  a payment to an allowlisted payee succeeds");

  const a1 = await call("pay_and_fetch", { url: `${sellerUrl}/listed`, max_amount: "0.001" });
  record("A1 payment to allowlisted payee", a1.tx, true);
  check(a1.paid === true && a1.pay_to === listed, "pay_and_fetch paid the allowlisted payee",
    `${a1.error ?? `${a1.amount} to ${a1.pay_to}`}\n        ${a1.explorer ?? ""}`);

  const events = a1.tx ? await eventsOf(a1.tx) : [];
  const described = events.map((e) => `${e.topic} (${e.emitter.slice(0, 8)}...)`);
  check(
    events.length === 2 &&
      events.some((e) => e.emitter === C.policySpendingLimit.id && e.topic === "spending_limit_enforced") &&
      events.some((e) => e.emitter === C.token.id && e.topic === "transfer") &&
      !events.some((e) => e.emitter === C.policyPayeeAllowlist.id),
    "its events: spending_limit_enforced and transfer, nothing from the allowlist", described.join(", ")
  );

  /* ---- A2 ------------------------------------------------------------------ */
  console.log("\nA2  a payment to a payee not on the list, under the cap, fails");

  const s0 = await call("tab_status", { tab_id: opened.tab_id });
  const a2 = await call("pay_and_fetch", { url: `${sellerUrl}/unlisted`, max_amount: "0.001" });
  check(codeOf(a2.error) === "3901", "pay_and_fetch is refused by the allowlist (#3901)", `remaining ${s0.remaining}, price 0.0001 TAB\n        ${a2.error}`);
  check(!sellerLog.signatures["/unlisted"], "nothing was sent to the seller");

  const donor = await footprintOf(a1.tx);
  const a2forced = await chain.send(
    { contract: C.token.id, fn: "transfer", args: [addr(C.smartAccount.id), addr(unlisted), i128(1000n)] },
    { signWith: agent, contextRuleId: opened.context_rule_id, force: donor }
  );
  record("A2 forced transfer to non-allowlisted payee", a2forced.hash, false);
  const a2out = await forcedOutcome(a2forced);
  check(!a2forced.ok && a2forced.stage === "execution" && a2out.code === "3901",
    "the same transfer, forced onto the ledger, FAILS ON CHAIN with #3901", a2out.line);

  /* ---- A2' ----------------------------------------------------------------- */
  console.log("\nA2' a payment to an allowlisted payee over the cap fails");

  const a2cap = await call("pay_and_fetch", { url: `${sellerUrl}/dear`, max_amount: "0.001" });
  check(codeOf(a2cap.error) === "3221", "pay_and_fetch is refused by the spending limit (#3221)", a2cap.error);

  const a2capForced = await chain.send(
    { contract: C.token.id, fn: "transfer", args: [addr(C.smartAccount.id), addr(listed), i128(4500n)] },
    { signWith: agent, contextRuleId: opened.context_rule_id, force: donor }
  );
  record("A2' forced over-cap transfer to allowlisted payee", a2capForced.hash, false);
  const a2capOut = await forcedOutcome(a2capForced);
  check(!a2capForced.ok && a2capForced.stage === "execution" && a2capOut.code === "3221",
    "the same transfer, forced onto the ledger, FAILS ON CHAIN with #3221", a2capOut.line);

  /* ---- A3 ------------------------------------------------------------------ */
  console.log("\nA3  the agent key cannot add a payee; the human signer can");

  const addPayee = { contract: C.policyPayeeAllowlist.id, fn: "add_payee", args: [xdr.ScVal.scvU32(opened.context_rule_id), addr(unlisted), addr(C.smartAccount.id)] };

  const a3agent = await chain.send(addPayee, { signWith: agent, contextRuleId: opened.context_rule_id, force: donor });
  record("A3 agent add_payee", a3agent.hash, false);
  const a3out = await forcedOutcome(a3agent);
  check(!a3agent.ok && a3agent.stage === "execution" && a3out.code === "3002",
    "add_payee signed by the agent key on the tab's rule FAILS ON CHAIN with #3002", a3out.line);

  const a3agentRule0 = await chain.send(addPayee, { signWith: agent, contextRuleId: 0 });
  check(!a3agentRule0.ok && codeOf(a3agentRule0.error) === "3002",
    "add_payee signed by the agent key naming the human signer's rule 0 is refused too (#3002, simulation)",
    `${a3agentRule0.stage}: ${codeOf(a3agentRule0.error) ? `Error(Contract, #${codeOf(a3agentRule0.error)})` : a3agentRule0.error}`);

  const listAfterAgent = await chain.read({ contract: C.policyPayeeAllowlist.id, fn: "get_payees", args: [xdr.ScVal.scvU32(opened.context_rule_id), addr(C.smartAccount.id)] });
  check(listAfterAgent.length === 1 && listAfterAgent[0] === listed, "the list on chain is unchanged", JSON.stringify(listAfterAgent));

  const a3admin = await chain.send(addPayee, { signWith: admin, contextRuleId: 0 });
  record("A3 human signer add_payee", a3admin.hash, true);
  check(a3admin.ok, "add_payee signed by the human signer (rule 0) succeeds", a3admin.hash ? explorerTx(a3admin.hash) : a3admin.error);

  const s3 = await call("tab_status", { tab_id: opened.tab_id });
  check(s3.allow_any_payee === false && s3.payees.includes(listed) && s3.payees.includes(unlisted),
    "tab_status reads the new list from the chain", s3.payees);

  const a3pay = await call("pay_and_fetch", { url: `${sellerUrl}/unlisted`, max_amount: "0.001" });
  record("A3 payment to the newly added payee", a3pay.tx, true);
  check(a3pay.paid === true && a3pay.pay_to === unlisted, "the payee refused in A2 now pays",
    `${a3pay.error ?? `${a3pay.amount} to ${a3pay.pay_to}`}\n        ${a3pay.explorer ?? ""}`);

  /* ---- receipts on the restricted tab ---------------------------------------- */
  const s4 = await call("tab_status", { tab_id: opened.tab_id });
  check(s4.receipts.length > 0 && s4.receipts.every((r) => r.allow_any_payee === false),
    "every receipt on the restricted tab carries allow_any_payee: false",
    s4.receipts.map((r) => `${r.kind}${r.refused_by ? `/${r.refused_by}` : ""}:${r.allow_any_payee}`).join(", "));
  const refusal = s4.receipts.find((r) => r.kind === "refused" && r.to === unlisted);
  check(Boolean(refusal && /#3901/.test(refusal.reason)), "the #3901 refusal is on the bill", JSON.stringify(refusal));

  const closed = await call("close_tab", { tab_id: opened.tab_id });
  record("closeTab (restricted)", closed.tx, true);
  closedRestricted = true;
  console.log(`\nclose_tab ${closed.error ?? `final spent ${closed.final_spent}\n  ${closed.explorer}`}`);
} finally {
  if (!closedRestricted) {
    const closed = await call("close_tab", { tab_id: opened.tab_id });
    console.log(`\nclose_tab (cleanup) ${closed.error ?? closed.explorer}`);
  }
}

/* ---- A4 (contract half): an empty list is refused by install ---------------- */
console.log("\nA4  the contract refuses an empty list on chain");

const a4expiry = (await chain.latestLedger()) + 120;
const ruleArgs = (payees) => {
  const policies = [
    [C.policySpendingLimit.id, nativeToScVal({ spending_limit: 5000n, period_ledgers: 180 }, { type: { spending_limit: ["symbol", "i128"], period_ledgers: ["symbol", "u32"] } })],
    [C.policyPayeeAllowlist.id, xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("payees"), val: xdr.ScVal.scvVec(payees.map(addr)) })])],
  ]
    .map(([id, val]) => ({ key: StrKey.decodeContract(id), id, val }))
    .sort((x, y) => Buffer.compare(x.key, y.key));
  return [
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), addr(C.token.id)]),
    nativeToScVal("agent", { type: "string" }),
    xdr.ScVal.scvU32(a4expiry),
    xdr.ScVal.scvVec([xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("External"), addr(C.verifierEd25519.id), xdr.ScVal.scvBytes(Buffer.from(rawEd25519Key(agent.publicKey())))])]),
    xdr.ScVal.scvMap(policies.map(({ id, val }) => new xdr.ScMapEntry({ key: addr(id), val }))),
  ];
};

const idBeforeA4 = await nextRuleId();
const a4 = await forceWithValidTwin(
  { contract: C.smartAccount.id, fn: "add_context_rule", args: ruleArgs([listed]) },
  { contract: C.smartAccount.id, fn: "add_context_rule", args: ruleArgs([]) },
  admin,
  0
);
record("A4 forced install with an empty list", a4.hash, false);
const a4out = await forcedOutcome(a4);
check(!a4.ok && a4.stage === "execution" && a4out.code === "3902",
  "add_context_rule with the allowlist and an empty list FAILS ON CHAIN with #3902 (EmptyAllowlist)", a4out.line);
const idAfterA4 = await nextRuleId();
check(idAfterA4 === idBeforeA4, "and no rule was created: NextId is unchanged", `NextId ${idBeforeA4} -> ${idAfterA4}`);

/* ---- A5 ------------------------------------------------------------------- */
console.log("\nA5  allow_any_payee: true is shown in tab_status and on every receipt");

const anyTab = await call("open_tab", { limit: "0.0001", window: "PT5M", allow_any_payee: true });
record("openTab (allow_any_payee)", anyTab.tx, true);
check(anyTab.allow_any_payee === true && /^Not restricted: this tab was opened with allow_any_payee/.test(anyTab.payees ?? ""),
  "open_tab reports allow_any_payee: true", anyTab.error ?? `${anyTab.explorer}\n        ${anyTab.payees}`);

const anyRule = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(anyTab.context_rule_id)] });
check(anyRule.policies.length === 1 && anyRule.policies[0] === C.policySpendingLimit.id, "its rule on chain has the spending limit and no allowlist", anyRule.policies.join(", "));

const anyStatus = await call("tab_status", { tab_id: anyTab.tab_id });
check(anyStatus.allow_any_payee === true && anyStatus.receipts.every((r) => r.allow_any_payee === true),
  "tab_status shows allow_any_payee: true, read from the rule on chain, and on its receipts",
  JSON.stringify({ allow_any_payee: anyStatus.allow_any_payee, receipts: anyStatus.receipts }));

const anyClosed = await call("close_tab", { tab_id: anyTab.tab_id });
record("closeTab (allow_any_payee)", anyClosed.tx, true);
// tab_status reads the spending limit, which close_tab uninstalls; the receipt log is read directly.
const stored = new Store().receipts(anyTab.tab_id);
check(stored.length === 2 && stored.every((r) => r.allowAnyPayee === true),
  "every receipt written for it (open, close) carries allow_any_payee: true", JSON.stringify(stored.map((r) => ({ kind: r.kind, allowAnyPayee: r.allowAnyPayee }))));

/* ---- Horizon cross-check ---------------------------------------------------- */
console.log("\nHorizon cross-check");

for (const { label, hash, expectSuccess } of onLedger) {
  const h = await (await fetch(`https://horizon-testnet.stellar.org/transactions/${hash}`)).json();
  check(h.successful === expectSuccess, `${label}: successful=${h.successful}`, `${hash} ledger ${h.ledger} fee ${h.fee_charged}`);
}

console.log(`\nsellers' signatures ${JSON.stringify(sellerLog.signatures)}, settlements ${JSON.stringify(sellerLog.settles)}`);
console.log(`\n${pass}/${pass + fail} as expected`);
process.exit(fail === 0 ? 0 : 1);
