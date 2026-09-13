/*
 * Register the human's passkey on the smart account, as its OWN Default rule.
 *
 * Not add_signer on rule 0. Rule 0 has no policies, and in stellar-accounts
 * 0.7.2 a rule without policies requires every one of its signers
 * (storage.rs, get_validated_context_by_id: "Without policies, all rule
 * signers must be matched"). A passkey on rule 0 would make open_tab and
 * close_tab 2-of-2, and nothing here can produce a passkey assertion for a
 * Soroban payload -- removing it again would need one too.
 *
 * A separate Default rule gives the passkey a full admin path of its own
 * while the ed25519 signer on rule 0 keeps working. The rule is added under
 * rule 0's authority.
 *
 * key_data is the 65-byte uncompressed P-256 point followed by the credential
 * id. The WebAuthn verifier verifies against the first 65 bytes and
 * canonicalize_key strips the rest; the credential id rides along so a browser
 * can later find it on chain for allowCredentials.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   PASSKEY_PUBLIC_KEY_HEX=04... PASSKEY_CREDENTIAL_ID_HEX=... PASSKEY_ORIGIN=http://localhost:8000 \
 *   npx tsx scripts/add-passkey-rule-testnet.mjs            # validate + simulate only
 *   npx tsx scripts/add-passkey-rule-testnet.mjs --submit   # and submit
 */
import { ECDH } from "node:crypto";

import {
  Address, BASE_FEE, Keypair, Operation, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, xdr,
} from "@stellar/stellar-sdk";

import { Chain, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";

const RULE_NAME = "passkey";
const MAX_EXTERNAL_KEY_SIZE = 256; // stellar-accounts 0.7.2 smart_account/mod.rs

const deployment = loadDeployment();
const C = deployment.contracts;
const submit = process.argv.includes("--submit");

const fail = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
};

/* ---- the inputs, checked before anything touches the network ------------- */

const pubHex = (process.env.PASSKEY_PUBLIC_KEY_HEX ?? "").trim().toLowerCase();
const credHex = (process.env.PASSKEY_CREDENTIAL_ID_HEX ?? "").trim().toLowerCase();
const origin = (process.env.PASSKEY_ORIGIN ?? "").trim();

if (!/^04[0-9a-f]{128}$/.test(pubHex)) fail("PASSKEY_PUBLIC_KEY_HEX must be 130 hex chars starting 04 (uncompressed P-256 point)");
if (!/^([0-9a-f]{2})+$/.test(credHex)) fail("PASSKEY_CREDENTIAL_ID_HEX must be non-empty, even-length hex");
if (!origin) fail("PASSKEY_ORIGIN is required: the origin the passkey was created on");

const pub = Buffer.from(pubHex, "hex");
const cred = Buffer.from(credHex, "hex");
const keyData = Buffer.concat([pub, cred]);

if (keyData.length > MAX_EXTERNAL_KEY_SIZE) {
  fail(`key_data is ${keyData.length} bytes; the account accepts at most ${MAX_EXTERNAL_KEY_SIZE} (credential id <= ${MAX_EXTERNAL_KEY_SIZE - 65} bytes)`);
}

try {
  // Throws unless the 65 bytes are a point on P-256.
  ECDH.convertKey(pub, "prime256v1", undefined, "hex", "compressed");
} catch {
  fail("PASSKEY_PUBLIC_KEY_HEX is not a valid point on P-256");
}

console.log(`public key     ${pubHex.slice(0, 18)}...${pubHex.slice(-8)} (on curve)`);
console.log(`credential id  ${cred.length} bytes`);
console.log(`key_data       ${keyData.length} bytes`);
console.log(`origin         ${origin}`);
console.log(`verifier       ${C.verifierWebAuthn.id}\n`);

/* ---- chain checks --------------------------------------------------------- */

const admin = Keypair.fromSecret(process.env.BARKEEP_ADMIN_SECRET);
const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET);
const chain = new Chain(
  { rpcUrl: deployment.rpcUrl, networkPassphrase: deployment.networkPassphrase, smartAccount: C.smartAccount.id, verifierEd25519: C.verifierEd25519.id },
  submitter
);

const canonical = await chain.read({
  contract: C.verifierWebAuthn.id,
  fn: "canonicalize_key",
  args: [xdr.ScVal.scvBytes(keyData)],
});
if (Buffer.compare(Buffer.from(canonical), pub) !== 0) fail("the WebAuthn verifier's canonicalize_key did not return the 65-byte point");
console.log("verifier canonicalize_key  ok: returns the 65-byte point");

const rulesBefore = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rules_count", args: [] });
console.log(`context rules on account   ${rulesBefore}`);

const invocation = {
  contract: C.smartAccount.id,
  fn: "add_context_rule",
  args: [
    xdr.ScVal.scvVec([nativeToScVal("Default", { type: "symbol" })]),
    nativeToScVal(RULE_NAME, { type: "string" }),
    xdr.ScVal.scvVoid(), // valid_until: none -- this is the human's standing admin path
    xdr.ScVal.scvVec([
      xdr.ScVal.scvVec([
        nativeToScVal("External", { type: "symbol" }),
        new Address(C.verifierWebAuthn.id).toScVal(),
        xdr.ScVal.scvBytes(keyData),
      ]),
    ]),
    xdr.ScVal.scvMap([]), // no policies: the passkey alone authorises this rule
  ],
};

if (!submit) {
  /*
   * Dry run: sign the auth entry with the rule-0 ed25519 key exactly as
   * Chain.send would, and simulate in enforcing mode, so __check_auth runs and
   * rule 0's authority over this add is actually exercised. Nothing is sent.
   */
  const build = async (auth) => {
    const source = await chain.server.getAccount(submitter.publicKey());
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: chain.network })
      .addOperation(Operation.invokeContractFunction({ contract: invocation.contract, function: invocation.fn, args: invocation.args, ...(auth ? { auth } : {}) }))
      .setTimeout(60)
      .build();
  };

  const recording = await chain.server.simulateTransaction(await build());
  if (rpc.Api.isSimulationError(recording)) fail(`recording simulation: ${recording.error.split("\n")[0]}`);

  const expiry = (await chain.latestLedger()) + 60;
  const signed = await Promise.all(
    (recording.result?.auth ?? []).map((e) => authorizeEntry(e, chain.signAs(admin, 0), expiry, chain.network))
  );
  const enforcing = await chain.server.simulateTransaction(await build(signed));
  if (rpc.Api.isSimulationError(enforcing)) fail(`enforcing simulation: ${enforcing.error.split("\n")[0]}`);

  console.log("add_context_rule simulation ok, signed by rule 0 (enforcing mode).");
  console.log("Nothing submitted. Re-run with --submit to add the rule.");
  process.exit(0);
}

const result = await chain.send(invocation, { signWith: admin, contextRuleId: 0 });
if (!result.ok) fail(`add_context_rule ${result.stage}: ${result.error}`);

const ruleId = result.returnValue?.id;
const rule = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(ruleId)] });
const [kind, verifier, storedKey] = rule.signers[0];

const matches =
  rule.signers.length === 1 &&
  kind === "External" &&
  verifier === C.verifierWebAuthn.id &&
  Buffer.compare(Buffer.from(storedKey), keyData) === 0 &&
  rule.policies.length === 0 &&
  rule.valid_until == null;

console.log(`\nadded rule ${ruleId} "${rule.name}"  ${explorerTx(result.hash)}`);
console.log(`read back: ${matches ? "matches" : "DOES NOT MATCH"} -- ${JSON.stringify({ ...rule, signers: rule.signers.length }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log(JSON.stringify({ contextRuleId: ruleId, tx: result.hash, keyDataBytes: keyData.length, credentialIdHex: credHex, publicKeyHex: pubHex, origin }, null, 2));
process.exit(matches ? 0 : 1);
