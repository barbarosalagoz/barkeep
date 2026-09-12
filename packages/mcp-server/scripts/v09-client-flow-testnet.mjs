/*
 * The smart-account client flow on stellar-accounts 4529d70 (#868), run
 * against real Testnet deployments rather than an in-memory Env.
 *
 * Fills in docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md:
 *
 *   E1  client digest vs the account's own auth_digest(preimage) view
 *       (and the preimage map with its keys in declaration order instead)
 *   E2  External signer signs sha256(preimage.to_xdr())          -> success
 *   E3  External signer signs the raw signature_payload           -> refused
 *   E4  External signer signs the 0.7.2 digest                    -> refused
 *   D0  recording simulation: how many auth entries come back
 *   D1  Delegated signer, hand-added __check_auth(preimage) entry -> success
 *   D2  Delegated signer, account entry only                      -> refused
 *   D3  Delegated signer, entry carries the digest, not the map   -> refused
 *   R1  cross-account replay, 0.7.2 accounts                      -> ?
 *   R2  cross-account replay, 4529d70 accounts                    -> ?
 *
 * Every refusal is submitted, not only simulated. A transaction whose
 * simulation fails has no footprint to assemble from, so each refused case
 * borrows one from a "donor": the same invocation with the same nonces and
 * expiration, correctly signed, simulated but never sent. Same ledger keys,
 * so the refused transaction reaches the ledger and its error is on chain.
 *
 *   ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   RESULTS_OUT=/path/to/results.json \
 *   npx tsx scripts/v09-client-flow-testnet.mjs      # from packages/mcp-server
 *
 * The agent key is both the External signer (as an ed25519 key under the
 * verifier) and the Delegated signer (as the G-account itself). Setup is
 * idempotent: rules are found by name before any is added.
 *
 * Secrets come from the environment and are never written anywhere.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  Address, BASE_FEE, Keypair, Networks, Operation, SorobanDataBuilder, StrKey,
  TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

import { authDigest, buildAuthPayload } from "../src/authDigest.ts";
import {
  authDigestPreimageScVal, authDigestV09, delegateAuthInvocation,
} from "../src/authDigestPreimage.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../deployments/testnet-v09.json", import.meta.url)));
const C = cfg.contracts;
const R072 = cfg.replay072;
const server = new rpc.Server(cfg.rpcUrl);
const NET = Networks.TESTNET;

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required (use: ${name}=$(stellar keys secret <identity>))`);
  return Keypair.fromSecret(v);
};
const admin = need("ADMIN_SECRET");
const agent = need("AGENT_SECRET");
const submitter = need("SUBMITTER_SECRET");

const PROBE = C.authProbe.id;
const V09 = { name: "4529d70", verifier: C.verifierEd25519.id };
const V072 = { name: "0.7.2", verifier: R072.verifierEd25519 };

const rawKey = (kp) => Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey()));
const external = (version, kp) => ({ kind: "external", verifier: version.verifier, keyData: rawKey(kp) });
const digestFor = (version, account, payload, ruleIds) =>
  version === V09 ? authDigestV09(account, payload, ruleIds) : authDigest(payload, ruleIds);

const explorer = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const results = {};
const log = (...a) => console.log(...a);

// ---- errors --------------------------------------------------------------

const ERR_TYPE = {
  sceContract: "Contract", sceWasmVm: "WasmVm", sceContext: "Context", sceStorage: "Storage",
  sceObject: "Object", sceCrypto: "Crypto", sceEvents: "Events", sceBudget: "Budget",
  sceValue: "Value", sceAuth: "Auth",
};
const fmtScError = (err) => {
  const type = ERR_TYPE[err.switch().name] ?? err.switch().name;
  if (err.switch().name === "sceContract") return `Error(Contract, #${err.contractCode()})`;
  return `Error(${type}, ${err.code().name.replace(/^scec/, "")})`;
};
function errorsInScVal(v, out) {
  switch (v.switch().name) {
    case "scvError": out.push(fmtScError(v.error())); break;
    case "scvVec": for (const x of v.vec() ?? []) errorsInScVal(x, out); break;
    case "scvMap": for (const e of v.map() ?? []) { errorsInScVal(e.key(), out); errorsInScVal(e.val(), out); } break;
    default: break;
  }
  return out;
}
/** Every ScError in a transaction's diagnostic events, in emission order, deduplicated. */
function diagnosticErrors(events = []) {
  const out = [];
  for (const ev of events) {
    const body = ev.event().body().v0();
    for (const t of body.topics()) errorsInScVal(t, out);
    errorsInScVal(body.data(), out);
  }
  return [...new Set(out)];
}
const simErrors = (text) => [...new Set((text ?? "").match(/Error\(\w+, ?#?\w+\)/g) ?? [])];

// ---- transactions ----------------------------------------------------------

async function buildTx(invocation, auth) {
  const source = await server.getAccount(submitter.publicKey());
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: NET })
    .addOperation(Operation.invokeContractFunction({
      contract: invocation.contract, function: invocation.fn, args: invocation.args,
      ...(auth ? { auth } : {}),
    }))
    .setTimeout(120)
    .build();
}

async function settle(hash) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await server.getTransaction(hash);
    if (got.status === "NOT_FOUND") continue;
    return {
      hash, ledger: got.ledger, status: got.status,
      errors: got.status === "SUCCESS" ? [] : diagnosticErrors(got.diagnosticEventsXdr),
      returnValue: got.returnValue ? scValToNative(got.returnValue) : undefined,
    };
  }
  return { hash, status: "TIMEOUT", errors: [] };
}

async function sendTx(tx) {
  tx.sign(submitter);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") {
    return { hash: sent.hash, status: "SEND_ERROR", errors: [sent.errorResult?.result().switch().name] };
  }
  return settle(sent.hash);
}

/** Read-only call through simulation. */
async function view(contract, fn, args = []) {
  const sim = await server.simulateTransaction(await buildTx({ contract, fn, args }));
  if (rpc.Api.isSimulationError(sim)) return { error: sim.error, errors: simErrors(sim.error) };
  return { value: sim.result?.retval ? scValToNative(sim.result.retval) : undefined, retval: sim.result?.retval };
}

/** Recording-mode simulation of the bare invocation: the auth entries the RPC says are needed. */
async function recordAuth(invocation) {
  const tx = await buildTx(invocation);
  const raw = await server._simulateTransaction(tx);
  const rawAuth = raw.results?.[0]?.auth ?? [];
  const entries = rawAuth.map((b64) => xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64"));
  if (raw.error) throw new Error(`recording simulation failed: ${raw.error}`);
  return {
    entries,
    rawCount: rawAuth.length,
    addresses: entries.map((e) => Address.fromScAddress(e.credentials().address().address()).toString()),
  };
}

/**
 * Simulate `invocation` carrying `entries`. On success, assemble and send. On
 * failure, record the simulation error, borrow the footprint of `donorEntries`
 * (same nonces, correctly signed) and send anyway, so the refusal is on chain.
 */
async function attempt(label, invocation, entries, donorEntries) {
  const tx = await buildTx(invocation, entries);
  const sim = await server.simulateTransaction(tx);
  const out = { label };

  if (!rpc.Api.isSimulationError(sim)) {
    out.simulation = "ok";
    out.chain = await sendTx(rpc.assembleTransaction(tx, sim).build());
  } else {
    out.simulation = "error";
    out.simulationErrors = simErrors(sim.error);
    if (!donorEntries) {
      out.chain = { status: "NOT_SUBMITTED", errors: [], note: "no donor footprint" };
    } else {
      const donorSim = await server.simulateTransaction(await buildTx(invocation, donorEntries));
      if (rpc.Api.isSimulationError(donorSim)) {
        out.chain = { status: "NOT_SUBMITTED", errors: simErrors(donorSim.error), note: "donor simulation failed" };
      } else {
        const data = donorSim.transactionData.build();
        const r = data.resources();
        const bumped = new SorobanDataBuilder(data)
          .setResources(Math.ceil(r.instructions() * 1.5), r.diskReadBytes(), r.writeBytes())
          .setResourceFee(BigInt(data.resourceFee().toString()) * 3n)
          .build();
        // build() adds sorobanData's resourceFee on top of this base fee.
        const forced = TransactionBuilder.cloneFrom(tx, { fee: BASE_FEE, sorobanData: bumped }).build();
        out.chain = await sendTx(forced);
      }
    }
  }

  const ok = out.chain?.status === "SUCCESS";
  log(`  ${label}`);
  log(`    simulation with signed entries: ${out.simulation}${out.simulationErrors ? " " + out.simulationErrors.join(" ") : ""}`);
  log(`    on chain: ${out.chain.status}${out.chain.ledger ? ` ledger ${out.chain.ledger}` : ""}` +
      `${out.chain.errors?.length ? " " + out.chain.errors.join(" ") : ""}`);
  if (out.chain.hash) log(`    tx ${explorer(out.chain.hash)}`);
  out.ok = ok;
  return out;
}

// ---- signing ---------------------------------------------------------------

/** Sign a smart-account entry with one External signer, capturing the host payload. */
async function signAccountEntry(entry, { version, account, kp, ruleIds, validUntil, sign }) {
  let payload;
  const signed = await authorizeEntry(entry, async (_preimage, p) => {
    payload = p;
    const message = sign ? sign(p) : digestFor(version, account, p, ruleIds);
    return {
      signatureScVal: buildAuthPayload([{ signer: external(version, kp), signature: kp.sign(message) }], ruleIds),
    };
  }, validUntil, NET);
  return { signed, payload };
}

/** The account's own entry for a Delegated signer: an AuthPayload with empty signature bytes. */
async function delegatedAccountEntry(entry, { delegate, ruleIds, validUntil }) {
  let payload;
  const signed = await authorizeEntry(entry, async (_preimage, p) => {
    payload = p;
    return {
      signatureScVal: buildAuthPayload(
        [{ signer: { kind: "delegated", address: delegate.publicKey() }, signature: new Uint8Array() }],
        ruleIds
      ),
    };
  }, validUntil, NET);
  return { signed, payload };
}

/** A root entry for a G-account, with a fixed nonce, signed by that account's key. */
function delegateEntry(kp, nonce, rootInvocation, validUntil) {
  const unsigned = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(kp.publicKey()).toScAddress(),
        nonce: new xdr.Int64(nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation,
  });
  return authorizeEntry(unsigned, kp, validUntil, NET);
}

const randomNonce = () => BigInt(Math.floor(Math.random() * 2 ** 47));

/** Copy an entry, replacing only the credential's address. Nonce, expiry, signature, invocation kept. */
function withAddress(entry, address) {
  const c = entry.credentials().address();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: c.nonce(),
        signatureExpirationLedger: c.signatureExpirationLedger(),
        signature: c.signature(),
      })
    ),
    rootInvocation: entry.rootInvocation(),
  });
}

// ---- setup -----------------------------------------------------------------

const invoke = (contract, fn, args) => ({ contract, fn, args });
const signerScVal = (s) =>
  s.kind === "delegated"
    ? xdr.ScVal.scvVec([nativeToScVal("Delegated", { type: "symbol" }), new Address(s.address).toScVal()])
    : xdr.ScVal.scvVec([
      nativeToScVal("External", { type: "symbol" }), new Address(s.verifier).toScVal(), xdr.ScVal.scvBytes(s.keyData),
    ]);

/** Find a context rule by name, or have the admin add it. Returns its id. */
async function ensureRule(version, account, name, signer) {
  const count = Number((await view(account, "get_context_rules_count")).value ?? 0);
  for (let id = 0; id < count + 4; id++) {
    const got = await view(account, "get_context_rule", [xdr.ScVal.scvU32(id)]);
    if (got.value?.name === name) return { id, tx: null };
  }

  const invocation = invoke(account, "add_context_rule", [
    xdr.ScVal.scvVec([nativeToScVal("CallContract", { type: "symbol" }), new Address(PROBE).toScVal()]),
    nativeToScVal(name, { type: "string" }),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([signerScVal(signer)]),
    xdr.ScVal.scvMap([]),
  ]);
  const { entries } = await recordAuth(invocation);
  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const { signed } = await signAccountEntry(entries[0], { version, account, kp: admin, ruleIds: [0], validUntil });
  const r = await attempt(`setup: ${version.name} ${account.slice(0, 6)} add_context_rule "${name}"`, invocation, [signed]);
  if (!r.ok) throw new Error(`could not add rule ${name} on ${account}`);
  return { id: r.chain.returnValue.id, tx: r.chain.hash };
}

log(`probe ${PROBE}`);
log(`agent ${agent.publicKey()}\n`);

const setup = {};
setup.v09A_external = await ensureRule(V09, C.probeAccountA.id, "probe-external", external(V09, agent));
setup.v09A_delegated = await ensureRule(V09, C.probeAccountA.id, "probe-delegated", { kind: "delegated", address: agent.publicKey() });
setup.v09B_external = await ensureRule(V09, C.probeAccountB.id, "probe-external", external(V09, agent));
setup.v072A_external = await ensureRule(V072, R072.probeAccountA.id, "probe-external", external(V072, agent));
setup.v072B_external = await ensureRule(V072, R072.probeAccountB.id, "probe-external", external(V072, agent));
results.setup = setup;
log(`\nrule ids: ${JSON.stringify(Object.fromEntries(Object.entries(setup).map(([k, v]) => [k, v.id])))}\n`);

// ---- External signer ---------------------------------------------------------

const A = C.probeAccountA.id;
const extRule = [setup.v09A_external.id];
const ping = (account) => invoke(PROBE, "ping", [new Address(account).toScVal()]);

log("External signer (4529d70)");
{
  const rec = await recordAuth(ping(A));
  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const good = await signAccountEntry(rec.entries[0], { version: V09, account: A, kp: agent, ruleIds: extRule, validUntil });

  // E1: the account's own view against this module, for the payload E2 signs.
  const clientDigest = authDigestV09(A, good.payload, extRule).toString("hex");
  const onChain = await view(A, "auth_digest", [authDigestPreimageScVal(A, good.payload, extRule)]);
  const viewDigest = onChain.value ? Buffer.from(onChain.value).toString("hex") : null;

  const declarationOrder = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("account"), val: new Address(A).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature_payload"), val: xdr.ScVal.scvBytes(Buffer.from(good.payload)) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec(extRule.map((i) => xdr.ScVal.scvU32(i))) }),
  ]);
  const unsorted = await view(A, "auth_digest", [declarationOrder]);

  results.E1 = {
    signaturePayload: Buffer.from(good.payload).toString("hex"),
    clientDigest, viewDigest, equal: clientDigest === viewDigest,
    declarationOrderKeys: { error: unsorted.error?.split("\n")[0] ?? null, errors: unsorted.errors ?? [], value: unsorted.value ? Buffer.from(unsorted.value).toString("hex") : null },
  };
  log(`  E1 client ${clientDigest}`);
  log(`     view   ${viewDigest}  ${results.E1.equal ? "EQUAL" : "DIFFERENT"}`);
  log(`     declaration-order map: ${unsorted.errors?.join(" ") || unsorted.error?.split("\n")[0] || "accepted: " + results.E1.declarationOrderKeys.value}`);

  results.E2 = await attempt("E2 sign sha256(preimage.to_xdr())", ping(A), [good.signed]);
}
{
  // E3 and E4 share one recorded entry (one nonce) with their donor.
  for (const [key, label, sign] of [
    ["E3", "E3 sign the raw signature_payload", (p) => p],
    ["E4", "E4 sign the 0.7.2 digest", (p) => authDigest(p, extRule)],
  ]) {
    const rec = await recordAuth(ping(A));
    const validUntil = (await server.getLatestLedger()).sequence + 60;
    const bad = await signAccountEntry(rec.entries[0], { version: V09, account: A, kp: agent, ruleIds: extRule, validUntil, sign });
    const donor = await signAccountEntry(rec.entries[0], { version: V09, account: A, kp: agent, ruleIds: extRule, validUntil });
    results[key] = await attempt(label, ping(A), [bad.signed], [donor.signed]);
  }
}

// ---- Delegated signer ----------------------------------------------------------

const delRule = [setup.v09A_delegated.id];
log("\nDelegated signer (4529d70)");
{
  const rec = await recordAuth(ping(A));
  results.D0 = { rawAuthCount: rec.rawCount, addresses: rec.addresses, authMode: "default (none passed)" };
  log(`  D0 recording simulation returned ${rec.rawCount} auth entr${rec.rawCount === 1 ? "y" : "ies"}: ${rec.addresses.join(", ")}`);

  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const acct = await delegatedAccountEntry(rec.entries[0], { delegate: agent, ruleIds: delRule, validUntil });
  const nonce = randomNonce();
  const del = await delegateEntry(agent, nonce, delegateAuthInvocation(A, acct.payload, delRule), validUntil);
  results.D1 = await attempt("D1 account entry + hand-added delegate entry __check_auth(preimage)", ping(A), [acct.signed, del]);
}
{
  const rec = await recordAuth(ping(A));
  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const acct = await delegatedAccountEntry(rec.entries[0], { delegate: agent, ruleIds: delRule, validUntil });
  const nonce = randomNonce();
  const donorDel = await delegateEntry(agent, nonce, delegateAuthInvocation(A, acct.payload, delRule), validUntil);
  results.D2 = await attempt("D2 account entry only", ping(A), [acct.signed], [acct.signed, donorDel]);
}
{
  const rec = await recordAuth(ping(A));
  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const acct = await delegatedAccountEntry(rec.entries[0], { delegate: agent, ruleIds: delRule, validUntil });
  const nonce = randomNonce();
  const digestArg = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(A).toScAddress(),
        functionName: "__check_auth",
        args: [xdr.ScVal.scvBytes(authDigestV09(A, acct.payload, delRule))],
      })
    ),
    subInvocations: [],
  });
  const badDel = await delegateEntry(agent, nonce, digestArg, validUntil);
  const donorDel = await delegateEntry(agent, nonce, delegateAuthInvocation(A, acct.payload, delRule), validUntil);
  results.D3 = await attempt("D3 delegate entry carries the 32-byte digest, not the map", ping(A), [acct.signed, badDel], [acct.signed, donorDel]);
}

// ---- cross-account replay -------------------------------------------------------

/*
 * ping_owner() takes no arguments, so the authorised invocation -- and the
 * host's signature_payload -- is the same whichever account owns the probe.
 * Sign and submit for A; point the probe at B; submit A's entry again with
 * only the address changed. Nonces are per address, so B's is unused.
 */
async function replay(key, version, accountA, accountB, ruleId) {
  log(`\n${key} cross-account replay (${version.name})`);
  const pingOwner = invoke(PROBE, "ping_owner", []);
  const out = { version: version.name, accountA, accountB, ruleId };

  out.setOwnerA = (await attempt(`${key} set_owner(A)`, invoke(PROBE, "set_owner", [new Address(accountA).toScVal()]), undefined)).chain.hash;
  const rec = await recordAuth(pingOwner);
  const validUntil = (await server.getLatestLedger()).sequence + 120;
  const forA = await signAccountEntry(rec.entries[0], { version, account: accountA, kp: agent, ruleIds: [ruleId], validUntil });
  out.legitimateA = await attempt(`${key} ping_owner signed for A`, pingOwner, [forA.signed]);

  out.setOwnerB = (await attempt(`${key} set_owner(B)`, invoke(PROBE, "set_owner", [new Address(accountB).toScVal()]), undefined)).chain.hash;
  const replayed = withAddress(forA.signed, accountB);
  const donorForB = (await signAccountEntry(withAddress(rec.entries[0], accountB), {
    version, account: accountB, kp: agent, ruleIds: [ruleId], validUntil,
  })).signed;
  out.samePayload = Buffer.from(forA.payload).equals(
    Buffer.from((await signAccountEntry(withAddress(rec.entries[0], accountB), { version, account: accountB, kp: agent, ruleIds: [ruleId], validUntil })).payload)
  );
  out.replayOnB = await attempt(`${key} A's signed entry replayed against B`, pingOwner, [replayed], [donorForB]);
  log(`    signature_payload identical for A and B: ${out.samePayload}`);
  return out;
}

if (setup.v072A_external.id !== setup.v072B_external.id || setup.v09A_external.id !== setup.v09B_external.id) {
  throw new Error(`replay needs the same rule id on both accounts: ${JSON.stringify(setup)}`);
}
results.R1 = await replay("R1", V072, R072.probeAccountA.id, R072.probeAccountB.id, setup.v072A_external.id);
results.R2 = await replay("R2", V09, C.probeAccountA.id, C.probeAccountB.id, setup.v09A_external.id);

// ---- summary -------------------------------------------------------------------

const outcome = (r) => r?.chain?.status ?? r?.replayOnB?.chain?.status;
log("\nsummary");
for (const k of ["E2", "E3", "E4", "D1", "D2", "D3"]) log(`  ${k} ${outcome(results[k])} ${(results[k].chain.errors ?? []).join(" ")}`);
log(`  R1 replay on B: ${results.R1.replayOnB.chain.status} ${(results.R1.replayOnB.chain.errors ?? []).join(" ")}`);
log(`  R2 replay on B: ${results.R2.replayOnB.chain.status} ${(results.R2.replayOnB.chain.errors ?? []).join(" ")}`);

results.meta = {
  finishedAt: new Date().toISOString(),
  latestLedger: (await server.getLatestLedger()).sequence,
  protocol: (await server.getNetwork()).protocolVersion,
};
if (process.env.RESULTS_OUT) writeFileSync(process.env.RESULTS_OUT, JSON.stringify(results, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
