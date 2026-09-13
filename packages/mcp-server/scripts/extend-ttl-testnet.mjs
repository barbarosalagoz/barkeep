/*
 * Extend the TTL of the deployed contracts' code and instances to the network
 * maximum, so the tab does not archive under a demo.
 *
 * Contract wasm and instance entries are persistent state with a TTL. Nothing
 * in the tab's own calls extends them, so they archive on schedule, and after
 * that every call to the contract fails at simulation. On 2026-09-13 all nine
 * were due around 2026-09-19 18:49 UTC.
 *
 * Covered: the wasm and instance of both verifiers, the spending-limit policy
 * and the smart account, and the TAB token's instance (a Stellar Asset
 * Contract has no wasm). Not covered: per-rule and per-balance storage, which
 * the contracts extend as they write it.
 *
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   npx tsx scripts/extend-ttl-testnet.mjs
 *
 * One transaction per contract. Prints each entry's expiry before and after,
 * read back from RPC.
 */
import { Address, BASE_FEE, Keypair, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";

import { loadDeployment } from "../src/deployment.ts";

const deployment = loadDeployment();
const C = deployment.contracts;
const server = new rpc.Server(deployment.rpcUrl);
const submitter = Keypair.fromSecret(process.env.BARKEEP_SUBMITTER_SECRET);

const instanceKey = (id) =>
  xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
const codeKey = (hash) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, "hex") }));

const groups = [
  ["smartAccount", [codeKey(C.smartAccount.wasmHash), instanceKey(C.smartAccount.id)]],
  ["policySpendingLimit", [codeKey(C.policySpendingLimit.wasmHash), instanceKey(C.policySpendingLimit.id)]],
  ["verifierEd25519", [codeKey(C.verifierEd25519.wasmHash), instanceKey(C.verifierEd25519.id)]],
  ["verifierWebAuthn", [codeKey(C.verifierWebAuthn.wasmHash), instanceKey(C.verifierWebAuthn.id)]],
  ["token", [instanceKey(C.token.id)]],
];

const settings = await server.getLedgerEntries(
  xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() }))
);
const maxEntryTtl = settings.entries[0].val.configSetting().stateArchivalSettings().maxEntryTtl();

/** Seconds per ledger, measured over the last 200 closes. */
const horizon = await (await fetch("https://horizon-testnet.stellar.org/ledgers?order=desc&limit=200")).json();
const recs = horizon._embedded.records;
const secsPerLedger =
  (Date.parse(recs[0].closed_at) - Date.parse(recs.at(-1).closed_at)) / 1000 / (recs[0].sequence - recs.at(-1).sequence);
const eta = (ledger, latest) => new Date(Date.parse(recs[0].closed_at) + (ledger - latest) * secsPerLedger * 1000).toISOString();

const liveUntil = async (keys) => {
  const r = await server.getLedgerEntries(...keys);
  const by = new Map(r.entries.map((e) => [e.key.toXDR("base64"), e.liveUntilLedgerSeq]));
  return { latest: r.latestLedger, values: keys.map((k) => by.get(k.toXDR("base64"))) };
};

const label = (k) => (k.switch().name === "contractCode" ? "wasm    " : "instance");

console.log(`maxEntryTtl ${maxEntryTtl} ledgers; ${secsPerLedger.toFixed(2)} s/ledger measured\n`);
const report = {};

for (const [name, keys] of groups) {
  const before = await liveUntil(keys);

  // extendTo is relative to the ledger the transaction applies in; stay one under the ceiling.
  const extendTo = maxEntryTtl - 1;
  const source = await server.getAccount(submitter.publicKey());
  const data = new xdr.SorobanTransactionData({
    ext: new xdr.SorobanTransactionDataExt(0),
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({ readOnly: keys, readWrite: [] }),
      instructions: 0,
      diskReadBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: new xdr.Int64(0),
  });
  const draft = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: deployment.networkPassphrase })
    .addOperation(Operation.extendFootprintTtl({ extendTo }))
    .setSorobanData(data)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(draft);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${name}: ${sim.error}`);

  const tx = rpc.assembleTransaction(draft, sim).build();
  tx.sign(submitter);
  const sent = await server.sendTransaction(tx);
  if (sent.status === "ERROR") throw new Error(`${name}: ${JSON.stringify(sent.errorResult)}`);

  let got;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    got = await server.getTransaction(sent.hash);
    if (got.status !== "NOT_FOUND") break;
  }

  const after = await liveUntil(keys);
  console.log(`${name}  ${got.status}  ledger ${got.ledger}  tx ${sent.hash}`);
  keys.forEach((k, i) =>
    console.log(`  ${label(k)}  ${before.values[i]} -> ${after.values[i]}  (~${eta(after.values[i], after.latest)})`)
  );

  report[name] = {
    tx: sent.hash,
    ledger: got.ledger,
    successful: got.status === "SUCCESS",
    liveUntilLedger: Object.fromEntries(keys.map((k, i) => [label(k).trim(), after.values[i]])),
    estimatedExpiry: eta(Math.min(...after.values), after.latest),
  };
}

console.log(`\n${JSON.stringify(report, null, 2)}`);
