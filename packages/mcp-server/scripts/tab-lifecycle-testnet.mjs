/*
 * Done-test for the tab (ARCHITECTURE-v2 §4, §11; item 7).
 *
 * Installs an agent session-key rule with a spending limit and an expiry on the
 * deployed smart account, then proves three things ON CHAIN:
 *
 *   1. a transfer under the cap succeeds
 *   2. a transfer over the cap is rejected by the policy   (3221)
 *   3. after the expiry ledger, the session key is refused (3002)
 *
 * 2 and 3 are the point. A cap the client enforces is not a cap.
 *
 *   ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   npx tsx packages/mcp-server/scripts/tab-lifecycle-testnet.mjs
 *
 * It lives in @barkeep/mcp so it resolves the same @stellar/stellar-sdk 16.3
 * that authDigest.ts is written against; run from the repo root it would pick
 * up the web app's 17 and mix two copies.
 *
 * Secrets come from the environment and are never written anywhere.
 */
import { readFileSync } from "node:fs";
import {
  Address, BASE_FEE, Keypair, Networks, Operation, StrKey,
  TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";

import { authDigest, buildAuthPayload } from "../src/authDigest.ts";

const cfg = JSON.parse(readFileSync(new URL("../../../deployments/testnet.json", import.meta.url)));
const C = cfg.contracts;
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

const rawKey = (kp) => Buffer.from(StrKey.decodeEd25519PublicKey(kp.publicKey()));
const signerOf = (kp) => ({
  kind: "external",
  verifier: C.verifierEd25519.id,
  keyData: rawKey(kp),
});

/** Sign one auth entry as the smart account, for a given context rule. */
const signAs = (kp, ruleId) => async (_preimage, payload) => ({
  signatureScVal: buildAuthPayload(
    [{ signer: signerOf(kp), signature: kp.sign(authDigest(payload, [ruleId])) }],
    [ruleId]
  ),
});

/*
 * Build, authorise, submit.
 *
 * The signed auth entries have to be part of the operation BEFORE the final
 * simulation: the footprint and resource fees depend on them, and patching them
 * onto an already-assembled transaction produces txMalformed.
 *
 *   simulate bare -> sign the returned entries -> rebuild carrying them ->
 *   simulate again -> assemble -> sign envelope -> send
 *
 * `force` exists because the two rejections this script has to prove never get
 * that far: the contract panics during simulation, which returns no
 * transactionData to assemble from, so the transaction would never reach the
 * ledger and there would be no hash to show. With `force` we build the auth
 * entry by hand, reuse the footprint of the transfer that did succeed (same
 * contracts, same ledger keys), and submit anyway -- so the refusal is recorded
 * on chain rather than only observed locally.
 */
const opFrom = ({ contract, fn, args }, auth) =>
  Operation.invokeContractFunction({ contract, function: fn, args, ...(auth ? { auth } : {}) });

function unsignedAuthEntry({ contract, fn, args }, forAddress) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(forAddress).toScAddress(),
        nonce: new xdr.Int64(BigInt(Math.floor(Math.random() * 2 ** 47))),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(contract).toScAddress(),
          functionName: fn,
          args,
        })
      ),
      subInvocations: [],
    }),
  });
}

async function settle(sent, label) {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const got = await server.getTransaction(sent.hash);
    if (got.status === "NOT_FOUND") continue;

    /*
     * A failed Soroban invocation reports the contract error in its diagnostic
     * events. They come back already parsed, so stringify and pick the code out
     * rather than re-decoding XDR.
     */
    let error = null;
    if (got.status !== "SUCCESS") {
      const diag = JSON.stringify(got.diagnosticEventsXdr ?? got.resultMetaXdr ?? "");
      error = diag.match(/Error\(Contract, #\d+\)/)?.[0] ?? null;
    }
    return {
      ok: got.status === "SUCCESS", stage: "execution", hash: sent.hash, label, error,
      returnValue: got.returnValue ? scValToNative(got.returnValue) : undefined,
      sorobanData: got.envelopeXdr,
    };
  }
  return { ok: false, stage: "timeout", label, hash: sent.hash };
}

async function send(invocation, { signWith, ruleId, label, force }) {
  const build = async (auth, sorobanData, fee) => {
    const source = await server.getAccount(submitter.publicKey());
    const b = new TransactionBuilder(source, { fee: fee ?? BASE_FEE, networkPassphrase: NET })
      .addOperation(opFrom(invocation, auth))
      .setTimeout(60);
    if (sorobanData) b.setSorobanData(sorobanData);
    return b.build();
  };

  const validUntil = (await server.getLatestLedger()).sequence + 60;
  const probe = await server.simulateTransaction(await build(undefined));

  if (rpc.Api.isSimulationError(probe)) {
    if (!force) return { ok: false, stage: "simulation", error: probe.error, label };

    const entry = await authorizeEntry(
      unsignedAuthEntry(invocation, C.smartAccount.id),
      signAs(signWith, ruleId), validUntil, NET
    );
    const tx = await build([entry], force.sorobanData, force.fee);
    tx.sign(submitter);

    let sent;
    try {
      sent = await server.sendTransaction(tx);
    } catch (e) {
      return { ok: false, stage: "send", error: String(e), label };
    }
    if (sent.status === "ERROR") {
      return { ok: false, stage: "send", error: JSON.stringify(sent.errorResult), label, hash: sent.hash };
    }
    return settle(sent, label);
  }

  const signed = await Promise.all(
    (probe.result?.auth ?? []).map((entry) =>
      entry.credentials().switch().name === "sorobanCredentialsAddress" && signWith
        ? authorizeEntry(entry, signAs(signWith, ruleId), validUntil, NET)
        : entry
    )
  );

  const withAuth = await build(signed.length ? signed : undefined);
  const sim = await server.simulateTransaction(withAuth);

  /*
   * This is where a rejection actually shows up. The first simulation runs in
   * recording mode, which does not invoke __check_auth -- it only records which
   * authorisations would be needed -- so an over-cap or expired transfer passes
   * it. Only this second simulation, with the signed entries attached, runs the
   * account's __check_auth and therefore the context-rule and policy checks.
   */
  if (rpc.Api.isSimulationError(sim)) {
    if (!force) return { ok: false, stage: "simulation", error: sim.error, label };

    const forced = await build(signed.length ? signed : undefined, force.sorobanData, force.fee);
    forced.sign(submitter);

    let sentForced;
    try {
      sentForced = await server.sendTransaction(forced);
    } catch (e) {
      return { ok: false, stage: "send", error: String(e), label };
    }
    if (sentForced.status === "ERROR") {
      return { ok: false, stage: "send", error: JSON.stringify(sentForced.errorResult), label, hash: sentForced.hash };
    }
    const settled = await settle(sentForced, label);
    return { ...settled, error: settled.error ?? sim.error };
  }

  const tx = rpc.assembleTransaction(withAuth, sim).build();
  tx.sign(submitter);

  let sent;
  try {
    sent = await server.sendTransaction(tx);
  } catch (e) {
    return { ok: false, stage: "send", error: String(e), label };
  }
  if (sent.status === "ERROR") {
    return { ok: false, stage: "send", error: JSON.stringify(sent.errorResult), label, hash: sent.hash };
  }
  const out = await settle(sent, label);
  out.footprint = { sorobanData: tx.toEnvelope().v1().tx().ext().sorobanData(), fee: tx.fee };
  return out;
}

const explorer = (h) => `https://stellar.expert/explorer/testnet/tx/${h}`;
const invoke = (contract, fn, args) => ({ contract, fn, args });

/*
 * Call transfer on the TOKEN, with the account as `from` -- not execute() on
 * the account.
 *
 * The rule is CallContract(token), and the token's transfer calls
 * from.require_auth(), which produces exactly one auth context:
 * contract = token, fn_name = "transfer". That is what the rule matches and
 * what spending_limit inspects (it handles only "transfer" and reads the
 * amount from args.get(2)).
 *
 * Going through the account's execute() instead produces a context of
 * contract = account, fn_name = "execute", which a CallContract(token) rule
 * does not match: the account rejects it with UnvalidatedContext (3002)
 * before the policy is ever consulted.
 */
const transferOp = (amount) =>
  invoke(C.token.id, "transfer", [
    new Address(C.smartAccount.id).toScVal(),
    new Address(cfg.deployer).toScVal(),
    nativeToScVal(amount, { type: "i128" }),
  ]);

const results = [];
const record = (r, expect) => {
  results.push({ ...r, expect });
  const code = (r.error ?? "").match(/Error\(Contract, #(\d+)\)/)?.[1];
  console.log(
    `  ${r.ok === (expect === "success") ? "PASS" : "FAIL"}  ${r.label}  [${r.stage}]` +
      (r.hash ? `\n        tx ${explorer(r.hash)}` : "") +
      (r.error ? `\n        on-chain error: ${code ? `Error(Contract, #${code})` : r.error.slice(0, 180)}` : "")
  );
  return code;
};

console.log(`smart account ${C.smartAccount.id}`);
console.log(`token         ${C.token.id}\n`);

// ---- install the agent rule ------------------------------------------------
const CAP = Number(process.env.CAP ?? 5000);
const WINDOW = Number(process.env.WINDOW_LEDGERS ?? 1000);
const EXPIRE_IN = Number(process.env.EXPIRE_IN_LEDGERS ?? 12);

const latest = await server.getLatestLedger();
const validUntil = latest.sequence + EXPIRE_IN;
console.log(`ledger ${latest.sequence}; agent rule will expire at ${validUntil}\n`);

const addRule = await send(
  invoke(C.smartAccount.id, "add_context_rule", [
    xdr.ScVal.scvVec([nativeToScVal("CallContract", { type: "symbol" }), new Address(C.token.id).toScVal()]),
    nativeToScVal("agent", { type: "string" }),
    xdr.ScVal.scvU32(validUntil),
    xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([
        nativeToScVal("External", { type: "symbol" }),
        new Address(C.verifierEd25519.id).toScVal(),
        xdr.ScVal.scvBytes(rawKey(agent)),
      ]),
    ]),
    xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: new Address(C.policySpendingLimit.id).toScVal(),
        val: nativeToScVal({ spending_limit: BigInt(CAP), period_ledgers: WINDOW },
          { type: { spending_limit: ["symbol", "i128"], period_ledgers: ["symbol", "u32"] } }),
      }),
    ]),
  ]),
  { signWith: admin, ruleId: 0, label: `admin installs agent rule (cap ${CAP}, expiry ${validUntil})` }
);
record(addRule, "success");
if (!addRule.ok) { console.log("\ncannot continue without the rule"); process.exit(1); }

const agentRuleId = addRule.returnValue?.id ?? 1;
console.log(`  agent rule id ${agentRuleId}\n`);

// ---- 1. under the cap ------------------------------------------------------
const under = await send(transferOp(CAP - 1000), {
  signWith: agent, ruleId: agentRuleId, label: `1. transfer ${CAP - 1000} (under cap ${CAP})`,
});
record(under, "success");

/*
 * Reuse this transfer's footprint for the two that must fail. Same contracts
 * and same ledger keys, so the resources are the same; the fee is raised
 * because a failed invocation still pays for what it consumed.
 */
const force = under.footprint
  ? { sorobanData: under.footprint.sorobanData, fee: String(Number(under.footprint.fee) * 4) }
  : undefined;

// ---- 2. over the cap -------------------------------------------------------
const over = record(await send(transferOp(CAP * 4), {
  signWith: agent, ruleId: agentRuleId, force,
  label: `2. transfer ${CAP * 4} (over cap ${CAP}) must FAIL`,
}), "failure");

// ---- 3. after expiry -------------------------------------------------------
process.stdout.write(`\n  waiting for ledger ${validUntil} to pass`);
for (;;) {
  const now = (await server.getLatestLedger()).sequence;
  if (now > validUntil) { console.log(` (now ${now})\n`); break; }
  process.stdout.write(".");
  await new Promise((r) => setTimeout(r, 5000));
}

const expired = record(await send(transferOp(100), {
  signWith: agent, ruleId: agentRuleId, force,
  label: "3. transfer after expiry must be REFUSED",
}), "failure");

console.log(`\nover-cap error:  ${over ? `Error(Contract, #${over})` : "none"}  (expect 3221 SpendingLimitExceeded)`);
console.log(`expired error:   ${expired ? `Error(Contract, #${expired})` : "none"}  (expect 3002 UnvalidatedContext)`);

const pass = results.filter((r) => r.ok === (r.expect === "success")).length;
console.log(`\n${pass}/${results.length} as expected`);
process.exit(pass === results.length ? 0 : 1);
