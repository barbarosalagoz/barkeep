/*
 * SPIKE, not a feature: can an x402 `exact` payment be made FROM the deployed
 * smart account, authorised by the agent session key under a tab's context
 * rule, and settled by the public facilitator?
 *
 * One seller, stood up locally on 127.0.0.1, speaking x402 v2 headers and
 * delegating verify/settle to a facilitator. Cases:
 *
 *   T0  control: a plain G-account pays the same seller, stock x402 client,
 *       public facilitator. Proves the seller + facilitator pipeline works, so
 *       any later refusal belongs to the smart account and not the harness.
 *   T1  stock x402 client, payer = smart account. Does the client even build it?
 *   T2  custom client scheme using Chain.signAs (the path chain.ts proved),
 *       payer = smart account, PUBLIC facilitator (x402.org).
 *   T3  same payload, facilitator = the same @x402/stellar 2.25.0 code run
 *       locally with only the fee ceiling raised. Exposes the next check.
 *   T4  same, with the fee ceiling raised AND event validation restricted to
 *       events emitted by the asset contract. Settles on chain if nothing else
 *       stands in the way.
 *
 *   BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
 *   BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
 *   BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
 *   npx tsx scripts/x402-spike-testnet.mjs
 *
 * Secrets come from the environment and are never written anywhere. The
 * seller and control payer are fresh throwaway keypairs held in memory.
 */
import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Account, Asset, BASE_FEE, Horizon, Keypair, Operation, StrKey, TransactionBuilder,
  authorizeEntry, nativeToScVal, rpc,
} from "@stellar/stellar-sdk";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader,
} from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme as StockClientScheme } from "@x402/stellar/exact/client";
import { ExactStellarScheme as FacilitatorScheme } from "@x402/stellar/exact/facilitator";

import { Chain, explorerTx } from "../src/chain.ts";
import { loadDeployment } from "../src/deployment.ts";
import { Store } from "../src/state.ts";
import { closeTab, openTab } from "../src/tabs.ts";

const NETWORK = "stellar:testnet";
const PUBLIC_FACILITATOR = "https://x402.org/facilitator";
const PRICE = "1000"; // base units of TAB, 7 decimals: 0.0001
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const deployment = loadDeployment();
const C = deployment.contracts;
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const server = new rpc.Server(deployment.rpcUrl);

const admin = Keypair.fromSecret(process.env.BARKEEP_ADMIN_SECRET);
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

const tabCfg = {
  token: C.token.id,
  tokenDecimals: 7,
  policyContract: C.policySpendingLimit.id,
  payeeAllowlistPolicy: C.policyPayeeAllowlist.id,
  verifierEd25519: C.verifierEd25519.id,
  smartAccount: C.smartAccount.id,
  adminContextRuleId: 0,
};

const log = (...a) => console.log(...a);
const results = {};

/* ---- classic setup: throwaway seller and control payer ------------------- */

const TAB = new Asset("TAB", deployment.deployer);

async function freshTrustingAccount(label) {
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!fb.ok) throw new Error(`friendbot ${label}: ${fb.status}`);

  const acct = await horizon.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: deployment.networkPassphrase })
    .addOperation(Operation.changeTrust({ asset: TAB }))
    .setTimeout(60)
    .build();
  tx.sign(kp);
  await horizon.submitTransaction(tx);
  log(`  ${label.padEnd(14)} ${kp.publicKey()} (friendbot + TAB trustline)`);
  return kp;
}

async function mintTab(to, amount) {
  const acct = await horizon.loadAccount(submitter.publicKey());
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: deployment.networkPassphrase })
    .addOperation(Operation.payment({ destination: to, asset: TAB, amount }))
    .setTimeout(60)
    .build();
  tx.sign(submitter);
  await horizon.submitTransaction(tx);
}

/* ---- the seller ----------------------------------------------------------- */

/**
 * A minimal x402 v2 seller: 402 + PAYMENT-REQUIRED, then on retry verify and
 * settle through whichever facilitator the current case selects. Every
 * facilitator answer is kept, verbatim, as evidence.
 */
function startSeller(payTo) {
  const state = { facilitator: null, calls: [] };

  const http = createHttpServer(async (req, res) => {
    const url = `http://${req.headers.host}${req.url}`;
    const requirements = {
      scheme: "exact",
      network: NETWORK,
      asset: C.token.id,
      amount: PRICE,
      payTo,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    };

    const sig = req.headers["payment-signature"];
    if (!sig) {
      const required = {
        x402Version: 2,
        resource: { url, description: "barkeep x402 spike", mimeType: "application/json" },
        accepts: [requirements],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) });
      res.end("{}");
      return;
    }

    try {
      const payload = decodePaymentSignatureHeader(sig);
      const verify = await state.facilitator.verify(payload, requirements);
      state.calls.push({ step: "verify", response: verify });

      if (!verify.isValid) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: verify.invalidReason, message: verify.invalidMessage }));
        return;
      }

      const settle = await state.facilitator.settle(payload, requirements);
      state.calls.push({ step: "settle", response: settle });

      if (!settle.success) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: settle.errorReason }));
        return;
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle),
      });
      res.end(JSON.stringify({ paid: true, tx: settle.transaction }));
    } catch (e) {
      state.calls.push({ step: "seller-exception", error: String(e) });
      res.writeHead(500);
      res.end(String(e));
    }
  });

  return new Promise((resolve) =>
    http.listen(0, "127.0.0.1", () => resolve({ state, http, url: `http://127.0.0.1:${http.address().port}/paid` }))
  );
}

/* ---- the smart-account client scheme -------------------------------------- */

/**
 * Same shape as @x402/stellar's client ExactStellarScheme, but the auth entry
 * is authorised through Chain.signAs -- the AuthPayload path chain.ts proved --
 * instead of the SDK's classic-account signature. The payload on the wire is
 * identical in kind: a base64 transaction whose auth entry is signed.
 */
function smartAccountScheme(contextRuleId) {
  return {
    scheme: "exact",
    async createPaymentPayload(x402Version, req) {
      const latest = (await server.getLatestLedger()).sequence;
      const maxLedger = latest + Math.ceil(req.maxTimeoutSeconds / 5);

      const build = (auth, sorobanData) => {
        const b = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), {
          fee: BASE_FEE,
          networkPassphrase: deployment.networkPassphrase,
        })
          .addOperation(
            Operation.invokeContractFunction({
              contract: req.asset,
              function: "transfer",
              args: [
                nativeToScVal(C.smartAccount.id, { type: "address" }),
                nativeToScVal(req.payTo, { type: "address" }),
                nativeToScVal(req.amount, { type: "i128" }),
              ],
              ...(auth ? { auth } : {}),
            })
          )
          .setTimeout(req.maxTimeoutSeconds);
        if (sorobanData) b.setSorobanData(sorobanData);
        return b.build();
      };

      const recording = await server.simulateTransaction(build());
      if (rpc.Api.isSimulationError(recording)) throw new Error(`recording simulation: ${recording.error}`);

      const entries = recording.result?.auth ?? [];
      const signed = await Promise.all(
        entries.map((e) =>
          authorizeEntry(e, chain.signAs(agent, contextRuleId), maxLedger, deployment.networkPassphrase)
        )
      );

      const withAuth = build(signed);
      const enforcing = await server.simulateTransaction(withAuth);
      if (rpc.Api.isSimulationError(enforcing)) throw new Error(`enforcing simulation: ${enforcing.error}`);

      const tx = rpc.assembleTransaction(withAuth, enforcing).build();
      results.clientSide = {
        authEntries: entries.length,
        subInvocations: signed.map((e) => e.rootInvocation().subInvocations().length),
        minResourceFee: enforcing.minResourceFee,
        contractEvents: (enforcing.events ?? [])
          .map((d) => d.event())
          .filter((ev) => ev.type().name === "contract")
          .map((ev) => ({
            contract: StrKey.encodeContract(ev.contractId()),
            topic0: ev.body().v0().topics()[0]?.sym?.()?.toString(),
          })),
      };
      return { x402Version, payload: { transaction: tx.toXDR() } };
    },
  };
}

/* ---- facilitators ---------------------------------------------------------- */

const publicFacilitator = new HTTPFacilitatorClient({ url: PUBLIC_FACILITATOR });

/** The same 2.25.0 facilitator code, run in-process with the deployer as its signer. */
function localFacilitator({ maxTransactionFeeStroops, onlyAssetEvents }) {
  const signer = createEd25519Signer(process.env.BARKEEP_SUBMITTER_SECRET, NETWORK);
  const scheme = new FacilitatorScheme([signer], { maxTransactionFeeStroops });

  if (onlyAssetEvents) {
    const original = scheme.validateSimulationEvents.bind(scheme);
    scheme.validateSimulationEvents = (events, from, to, amount, asset) =>
      original(
        events.filter((d) => {
          const ev = d.event();
          return ev.type().name !== "contract" || StrKey.encodeContract(ev.contractId()) === asset;
        }),
        from, to, amount, asset
      );
  }

  // The x402 core passes a PaymentPayload; the scheme reads .payload and .accepted.
  return { verify: (p, r) => scheme.verify(p, r), settle: (p, r) => scheme.settle(p, r) };
}

/* ---- run ------------------------------------------------------------------ */

async function pay(seller, facilitator, schemeClient, spendControls) {
  seller.state.facilitator = facilitator;
  seller.state.calls = [];
  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: schemeClient }],
    spendControls,
  });
  const paidFetch = wrapFetchWithPayment(fetch, client);

  try {
    const res = await paidFetch(seller.url);
    const body = await res.text();
    return { status: res.status, body, calls: seller.state.calls };
  } catch (e) {
    return { thrown: String(e?.cause ?? e), calls: seller.state.calls };
  }
}

const spendControls = { allowedAssets: [{ network: NETWORK, asset: C.token.id, maxAmountPerPayment: PRICE }] };

log("setup");
log(`  smart account  ${C.smartAccount.id}`);
log(`  agent key      ${agent.publicKey()}`);
log(`  token (TAB)    ${C.token.id}`);
const sellerKp = await freshTrustingAccount("seller payTo");
const payerKp = await freshTrustingAccount("control payer");
await mintTab(payerKp.publicKey(), "0.01");
log(`  minted 0.01 TAB to the control payer`);

const seller = await startSeller(sellerKp.publicKey());
log(`  seller         ${seller.url}`);

const supported = await publicFacilitator.getSupported();
log(`  public facilitator stellar kinds: ${JSON.stringify(supported.kinds.filter((k) => k.network.startsWith("stellar")))}`);

/* T0 */
log("\nT0  control: G-account payer, stock client, public facilitator");
results.T0 = await pay(
  seller,
  publicFacilitator,
  new StockClientScheme(createEd25519Signer(payerKp.secret(), NETWORK)),
  spendControls
);
log(JSON.stringify(results.T0, null, 2));

/* The tab */
log("\nopening a tab (agent rule on the smart account)");
process.env.BARKEEP_STATE_DIR ??= mkdtempSync(join(tmpdir(), "barkeep-x402-spike-"));
const store = new Store(process.env.BARKEEP_STATE_DIR);
const tab = await openTab(chain, store, tabCfg, admin, agent, { limit: "0.01", window: "PT15M", allow_any_payee: true });
log(`  tab ${tab.tabId} rule ${tab.contextRuleId} expiry ${tab.expiryLedger}\n  ${explorerTx(tab.tx)}`);

try {
  /* T1 */
  log("\nT1  stock client, payer = smart account (signAuthEntry from the agent key)");
  const agentSigner = createEd25519Signer(agent.secret(), NETWORK);
  results.T1 = await pay(
    seller,
    publicFacilitator,
    new StockClientScheme({ address: C.smartAccount.id, signAuthEntry: agentSigner.signAuthEntry }),
    spendControls
  );
  log(JSON.stringify(results.T1, null, 2));

  /* T2 */
  log("\nT2  signAs client, payer = smart account, PUBLIC facilitator");
  results.T2 = await pay(seller, publicFacilitator, smartAccountScheme(tab.contextRuleId), spendControls);
  log(JSON.stringify(results.T2, null, 2));
  log(`  client-side simulation: ${JSON.stringify(results.clientSide)}`);

  /* T3 */
  log("\nT3  same, local 2.25.0 facilitator, fee ceiling raised to 2,000,000 stroops only");
  results.T3 = await pay(
    seller,
    localFacilitator({ maxTransactionFeeStroops: 2_000_000, onlyAssetEvents: false }),
    smartAccountScheme(tab.contextRuleId),
    spendControls
  );
  log(JSON.stringify(results.T3, null, 2));

  /* T4 */
  log("\nT4  same, local facilitator, fee ceiling raised + events limited to the asset contract");
  results.T4 = await pay(
    seller,
    localFacilitator({ maxTransactionFeeStroops: 2_000_000, onlyAssetEvents: true }),
    smartAccountScheme(tab.contextRuleId),
    spendControls
  );
  log(JSON.stringify(results.T4, null, 2));
  const settledTx = results.T4.calls.find((c) => c.step === "settle")?.response?.transaction;
  if (settledTx) log(`  ${explorerTx(settledTx)}`);
} finally {
  log("\nclosing the tab");
  const closed = await closeTab(chain, store, tabCfg, admin, tab.tabId);
  log(`  final spent ${closed.finalSpent}  ${explorerTx(closed.tx)}`);
  seller.http.close();
}
