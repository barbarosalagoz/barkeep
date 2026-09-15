/*
 * Sign one transaction from the smart account with the human's PASSKEY.
 *
 * The private key lives in a browser authenticator, so this is a two-step
 * handoff with scripts/passkey-sign.html in the middle:
 *
 *   prepare  build the transaction, fix its auth entry (nonce, expiry ledger),
 *            compute the digest the account will ask the passkey for, and
 *            print the page URL that carries it. Nothing is sent.
 *   submit   take the assertion the page printed, wrap it the way the account
 *            expects, simulate in enforcing mode, submit, and read the result
 *            back from RPC and Horizon.
 *   status   show what is pending.
 *
 * The digest is the same one the ed25519 path signs (src/authDigest.ts):
 *
 *   auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
 *
 * and it is the WebAuthn challenge. The verifier compares the clientDataJSON
 * challenge to base64url(auth_digest) byte for byte (3114 on mismatch), so the
 * assertion is bound to this transaction and this rule.
 *
 * What goes in AuthPayload.signers for the passkey is NOT the raw signature.
 * It is the XDR of WebAuthnSigData { signature, authenticator_data,
 * client_data }, one Bytes value, which the verifier decodes with from_xdr.
 *
 * The prepared transaction lives in the state directory (src/state.ts), never
 * the repo, as passkey-pending.json. It holds public values only.
 *
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   npx tsx scripts/passkey-sign-testnet.mjs prepare --rule <id> [--to G...] [--amount 1000] [--hours 24]
 *   npx tsx scripts/passkey-sign-testnet.mjs submit --assertion '<json from the page>'
 *   npx tsx scripts/passkey-sign-testnet.mjs status
 *
 * The submitter pays the fee and authorises nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  Address, BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

import { authDigest, buildAuthPayload } from "../src/authDigest.ts";
import { Chain, contractErrorCode, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";
import { stateDir } from "../src/state.ts";

const deployment = loadDeployment();
const C = deployment.contracts;
const PENDING = join(stateDir(), "passkey-pending.json");
const PAGE = "http://localhost:8000/passkey-sign.html";

const [command = "status", ...rest] = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? fallback : rest[i + 1];
};
const fail = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
};

const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET ?? fail("BARKEEP_SUBMITTER_SECRET is not set"));
const chain = new Chain(
  { rpcUrl: deployment.rpcUrl, networkPassphrase: deployment.networkPassphrase, smartAccount: C.smartAccount.id, verifierEd25519: C.verifierEd25519.id },
  submitter
);

const hex = (b) => Buffer.from(b).toString("hex");
const readPending = () => (existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : null);

/** The passkey rule as the chain has it: one External signer on the WebAuthn verifier. */
async function passkeyRule(ruleId) {
  const rule = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(ruleId)] });
  if (rule.signers.length !== 1) fail(`rule ${ruleId} has ${rule.signers.length} signers; expected exactly the passkey`);
  const [kind, verifier, keyData] = rule.signers[0];
  if (kind !== "External" || verifier !== C.verifierWebAuthn.id) {
    fail(`rule ${ruleId}'s signer is ${kind} on ${verifier}, not External on the WebAuthn verifier ${C.verifierWebAuthn.id}`);
  }
  const key = Buffer.from(keyData);
  if (key.length < 65 || key[0] !== 0x04) fail(`rule ${ruleId}'s key_data is not a 65-byte uncompressed point plus credential id`);
  return { rule, keyData: key, publicKey: key.subarray(0, 65), credentialId: key.subarray(65) };
}

function buildTx(source, invocation, auth, sorobanData, fee) {
  const b = new TransactionBuilder(source, { fee: fee ?? BASE_FEE, networkPassphrase: chain.network })
    .addOperation(Operation.invokeContractFunction({ contract: invocation.contract, function: invocation.fn, args: invocation.args, ...(auth ? { auth } : {}) }))
    .setTimeout(300);
  if (sorobanData) b.setSorobanData(sorobanData);
  return b.build();
}

/* ------------------------------------------------------------------------- */

if (command === "status") {
  const p = readPending();
  if (!p) {
    console.log(`nothing pending (${PENDING})`);
    process.exit(0);
  }
  const ledger = await chain.latestLedger();
  console.log(JSON.stringify({ ...p, entryXdr: undefined, argsXdr: undefined, currentLedger: ledger, expired: ledger > p.expiryLedger, page: p.url }, null, 2));
  process.exit(0);
}

if (command === "prepare") {
  const ruleId = Number(flag("rule", NaN));
  if (!Number.isInteger(ruleId) || ruleId < 0) fail("--rule <context rule id of the passkey rule> is required");
  const to = flag("to", deployment.demoSeller?.account);
  if (!to || !StrKey.isValidEd25519PublicKey(to)) fail("--to must be a G... account (default: demoSeller.account in the deployment record)");
  const amount = BigInt(flag("amount", "1000"));
  const hours = Number(flag("hours", "24"));

  const { keyData, publicKey, credentialId } = await passkeyRule(ruleId);
  if (credentialId.length === 0) fail("the rule's key_data carries no credential id; the page needs it for allowCredentials");

  const invocation = {
    contract: C.token.id,
    fn: "transfer",
    args: [new Address(C.smartAccount.id).toScVal(), new Address(to).toScVal(), nativeToScVal(amount, { type: "i128" })],
  };

  const source = await chain.server.getAccount(submitter.publicKey());
  const recording = await chain.server.simulateTransaction(buildTx(source, invocation));
  if (rpc.Api.isSimulationError(recording)) fail(`recording simulation: ${recording.error.split("\n")[0]}`);

  const entries = (recording.result?.auth ?? []).filter((e) => e.credentials().switch().name === "sorobanCredentialsAddress");
  if (entries.length !== 1) fail(`expected one address auth entry (the smart account), got ${entries.length}`);

  /*
   * Fix the entry: authorizeEntry sets the expiry ledger and hashes the
   * preimage. The callback only captures the payload; the placeholder
   * signature is replaced at submit time.
   */
  const latest = await chain.latestLedger();
  const expiryLedger = latest + Math.max(60, Math.round((hours * 3600) / 5));
  let payload = null;
  const entry = await authorizeEntry(
    entries[0],
    async (_preimage, p) => {
      payload = Buffer.from(p);
      return { signatureScVal: xdr.ScVal.scvVoid() };
    },
    expiryLedger,
    chain.network
  );
  if (!payload || payload.length !== 32) fail("did not capture a 32-byte signature payload");

  const digest = authDigest(payload, [ruleId]);
  const action = `transfer ${amount} base units of ${C.token.symbol} from the smart account to ${to}`;
  const url =
    `${PAGE}#` +
    new URLSearchParams({
      challenge: hex(digest),
      credential: hex(credentialId),
      key: hex(publicKey),
      rule: String(ruleId),
      expires: String(expiryLedger),
      account: C.smartAccount.id,
      action,
    }).toString();

  const pending = {
    network: deployment.network,
    action,
    invocation: { contract: invocation.contract, fn: invocation.fn },
    argsXdr: invocation.args.map((a) => a.toXDR("base64")),
    entryXdr: entry.toXDR("base64"),
    ruleId,
    verifier: C.verifierWebAuthn.id,
    keyDataHex: hex(keyData),
    payloadHex: hex(payload),
    digestHex: hex(digest),
    expiryLedger,
    preparedAtLedger: latest,
    preparedAt: new Date().toISOString(),
    url,
  };
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(PENDING, JSON.stringify(pending, null, 2) + "\n");

  console.log(`prepared: ${action}`);
  console.log(`rule ${ruleId}, auth entry valid until ledger ${expiryLedger} (now ${latest}, about ${hours}h)`);
  console.log(`signature payload  ${hex(payload)}`);
  console.log(`auth digest        ${hex(digest)}  <- the WebAuthn challenge`);
  console.log(`saved to ${PENDING}\n`);
  console.log("Serve scripts/ on port 8000 (python3 -m http.server 8000 --directory scripts), then open:\n");
  console.log(url + "\n");
  console.log("Click \"Sign with passkey\", copy the JSON, and run:\n  npx tsx scripts/passkey-sign-testnet.mjs submit --assertion '<json>'");
  process.exit(0);
}

if (command === "submit") {
  const p = readPending() ?? fail(`nothing pending at ${PENDING}; run prepare first`);
  const raw = flag("assertion-file") ? readFileSync(flag("assertion-file"), "utf8") : flag("assertion") ?? fail("--assertion '<json>' or --assertion-file <path> is required");
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    fail("the assertion is not JSON");
  }
  for (const k of ["challenge", "signature", "authenticator_data", "client_data"]) {
    if (typeof a[k] !== "string" || !/^([0-9a-f]{2})+$/i.test(a[k])) fail(`assertion.${k} must be hex`);
  }
  if (a.challenge.toLowerCase() !== p.digestHex) fail(`the assertion was made over ${a.challenge}, but the pending digest is ${p.digestHex}; run prepare again and sign that`);
  const signature = Buffer.from(a.signature, "hex");
  if (signature.length !== 64) fail(`signature must be 64 raw bytes (r || s), got ${signature.length}`);
  const authenticatorData = Buffer.from(a.authenticator_data, "hex");
  const clientData = Buffer.from(a.client_data, "hex");

  const ledger = await chain.latestLedger();
  if (ledger > p.expiryLedger) fail(`the auth entry expired at ledger ${p.expiryLedger} (now ${ledger}); run prepare again`);

  /* WebAuthnSigData as an ScVal map, keys in sorted order, then its XDR as one Bytes value. */
  const sigData = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("authenticator_data"), val: xdr.ScVal.scvBytes(authenticatorData) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("client_data"), val: xdr.ScVal.scvBytes(clientData) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature"), val: xdr.ScVal.scvBytes(signature) }),
  ]);
  const sigDataXdr = sigData.toXDR();

  const signer = { kind: "external", verifier: p.verifier, keyData: Buffer.from(p.keyDataHex, "hex") };
  const authPayload = buildAuthPayload([{ signer, signature: sigDataXdr }], [p.ruleId]);

  const entry = xdr.SorobanAuthorizationEntry.fromXDR(p.entryXdr, "base64");
  entry.credentials().address().signature(authPayload);

  const invocation = { contract: p.invocation.contract, fn: p.invocation.fn, args: p.argsXdr.map((x) => xdr.ScVal.fromXDR(x, "base64")) };

  const source = await chain.server.getAccount(submitter.publicKey());
  const withAuth = buildTx(source, invocation, [entry]);
  const sim = await chain.server.simulateTransaction(withAuth);
  if (rpc.Api.isSimulationError(sim)) {
    console.error("enforcing simulation refused the passkey signature:\n" + sim.error);
    process.exit(1);
  }
  console.log("enforcing simulation ok: __check_auth accepted the passkey assertion on rule " + p.ruleId);

  const tx = rpc.assembleTransaction(withAuth, sim).build();
  tx.sign(submitter);
  const sent = await chain.server.sendTransaction(tx);
  if (sent.status === "ERROR") fail(`send: ${JSON.stringify(sent.errorResult)}`);

  let got;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    got = await chain.server.getTransaction(sent.hash);
    if (got.status !== "NOT_FOUND") break;
  }
  if (!got || got.status === "NOT_FOUND") fail(`transaction ${sent.hash} not observed in 60s`);

  const contractError = got.status === "SUCCESS" ? null : contractErrorCode(got.diagnosticEventsXdr ?? []);

  /* Events the ledger recorded, from the transaction meta. */
  const events = [];
  try {
    const meta = got.resultMetaXdr;
    const list =
      meta.switch() === 3
        ? meta.v3().sorobanMeta()?.events() ?? []
        : meta.switch() === 4
          ? (meta.v4().operations()?.[0]?.events() ?? []).map((e) => e.event?.() ?? e)
          : [];
    for (const ev of list) {
      const body = ev.body().v0();
      const topics = body.topics().map((t) => {
        try { return scValToNative(t); } catch { return t.toXDR("base64"); }
      });
      let data;
      try { data = scValToNative(body.data()); } catch { data = body.data().toXDR("base64"); }
      const contractId = ev.contractId() ? Address.contract(ev.contractId()).toString() : null;
      events.push({ contract: contractId, topics, data });
    }
  } catch (e) {
    events.push({ note: `events not decoded: ${e.message}` });
  }

  /* Cross-check on Horizon, an independent reader of the same ledger. */
  let horizon;
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/transactions/${sent.hash}`);
    const j = await res.json();
    horizon = { successful: j.successful, ledger: j.ledger, feeCharged: j.fee_charged, sourceAccount: j.source_account };
  } catch (e) {
    horizon = { error: e.message };
  }

  const record = {
    tx: sent.hash,
    explorer: explorerTx(sent.hash),
    ledger: got.ledger,
    successful: got.status === "SUCCESS",
    error: contractError === null ? null : `Error(Contract, #${contractError})`,
    contextRuleId: p.ruleId,
    action: p.action,
    authDigest: p.digestHex,
    assertionFlags: `0x${authenticatorData[32].toString(16).padStart(2, "0")}`,
    clientDataOrigin: (() => { try { return JSON.parse(clientData.toString("utf8")).origin; } catch { return null; } })(),
    horizon,
    events: events.map((e) => (typeof e.data === "bigint" ? { ...e, data: e.data.toString() } : e)),
  };
  console.log(JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  if (record.successful) {
    writeFileSync(PENDING + ".done", JSON.stringify({ ...p, result: record }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    console.log(`\nsubmitted and confirmed. Record above goes in deployments/testnet.json under doneTests.passkeySign.`);
  }
  process.exit(record.successful ? 0 : 1);
}

fail(`unknown command ${command}; use prepare, submit or status`);
