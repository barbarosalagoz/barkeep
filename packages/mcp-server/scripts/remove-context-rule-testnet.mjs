/*
 * Remove one context rule from the smart account, under rule 0's authority.
 *
 * The admin tool close_tab does this for a tab it knows about; this is the
 * same call for a rule the server never recorded (a rehearsal rule, a stale
 * one). It refuses rule 0, which would strand the account.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   npx tsx scripts/remove-context-rule-testnet.mjs <rule id>
 */
import { Keypair, xdr } from "@stellar/stellar-sdk";

import { Chain, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";

const deployment = loadDeployment();
const C = deployment.contracts;
const ruleId = Number(process.argv[2]);

const fail = (msg) => {
  console.error(`REFUSED: ${msg}`);
  process.exit(1);
};
if (!Number.isInteger(ruleId) || ruleId < 0) fail("usage: remove-context-rule-testnet.mjs <rule id>");
if (ruleId === 0) fail("rule 0 is the human's admin path; removing it would strand the account");

const admin = Keypair.fromSecret(process.env.BARKEEP_ADMIN_SECRET ?? fail("BARKEEP_ADMIN_SECRET is not set"));
const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET ?? fail("BARKEEP_SUBMITTER_SECRET is not set"));
const chain = new Chain(
  { rpcUrl: deployment.rpcUrl, networkPassphrase: deployment.networkPassphrase, smartAccount: C.smartAccount.id, verifierEd25519: C.verifierEd25519.id },
  submitter
);

const before = await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(ruleId)] });
console.log(`rule ${ruleId} "${before.name}": ${before.signers.length} signer(s), ${before.policies.length} policy(ies)`);

const result = await chain.send(
  { contract: C.smartAccount.id, fn: "remove_context_rule", args: [xdr.ScVal.scvU32(ruleId)] },
  { signWith: admin, contextRuleId: 0 }
);
if (!result.ok) fail(`remove_context_rule ${result.stage}: ${result.error}`);

let gone = false;
try {
  await chain.read({ contract: C.smartAccount.id, fn: "get_context_rule", args: [xdr.ScVal.scvU32(ruleId)] });
} catch (e) {
  gone = /Error\(Contract, #3000\)/.test(e.message);
}
console.log(`removed rule ${ruleId}  ${explorerTx(result.hash)}`);
console.log(JSON.stringify({ removedRuleId: ruleId, tx: result.hash, readBackAfter: gone ? "Error(Contract, #3000) ContextRuleNotFound" : "STILL PRESENT" }, null, 2));
process.exit(gone ? 0 : 1);
