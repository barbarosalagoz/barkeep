/*
 * Barkeep's x402 facilitator: @x402/stellar 2.25.0, with two checks relaxed.
 *
 * WHY THIS EXISTS. The public facilitator (https://x402.org/facilitator) runs
 * the same upstream code with its defaults, and refuses every payment from a
 * Barkeep smart account (deployments/testnet.json, doneTests.x402Spike):
 *
 *   T2  invalid_exact_stellar_payload_fee_exceeds_maximum
 *       "simulation-derived fee 324039 stroops exceeds ceiling 50000 stroops"
 *   T3  invalid_exact_stellar_payload_event_not_transfer   (ceiling raised)
 *   T4  settled on chain                                    (both relaxed)
 *
 * So a seller must point at a facilitator like this one for Barkeep to pay
 * it. That is a real limit on who Barkeep can pay, and the tool description
 * and README say so.
 *
 * Everything else is upstream, unmodified: payload shape, asset, function,
 * recipient and amount checks, the facilitator-safety checks (not the payer,
 * not in any auth entry, not the source), credential type, signature expiry,
 * no sub-invocations, no pending signatures, the rebuild and the submission.
 * Keep it that way. Each relaxation below names the upstream check it relaxes;
 * anything not named here must not be changed in this file.
 *
 * @x402/stellar is pinned exactly (2.25.0) in package.json because relaxation
 * 2 reaches a TypeScript-private method. facilitator.test.ts fails if an
 * upgrade renames or removes it.
 */

import { createServer, type IncomingMessage, type RequestListener } from "node:http";

import { StrKey, type xdr } from "@stellar/stellar-sdk";
import { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import { loadDeployment } from "./deployment.ts";
import { keypairFromEnv } from "./keys.ts";
import { X402_NETWORK } from "./x402Scheme.ts";

/*
 * RELAXATION 1 -- upstream `maxTransactionFeeStroops` (default 50_000), checked
 * in ExactStellarScheme._verify as invalid_exact_stellar_payload_fee_exceeds_maximum.
 *
 * A smart-account transfer costs far more than a classic one: __check_auth
 * calls the ed25519 verifier contract, and the spending-limit policy reads and
 * rewrites its spending history. Measured: 324,039 stroops simulated for our
 * account (x402Spike T2) against 23,039 charged for a G-account transfer (T0).
 * The ceiling still exists, it is a constructor option rather than a patch,
 * and it is what bounds what a hostile payer can make this facilitator spend
 * in fees. 1,000,000 stroops (0.1 XLM) leaves room for the history entry
 * growing through a window without removing the bound.
 */
export const MAX_TRANSACTION_FEE_STROOPS = 1_000_000;

type EventCheck = (
  events: xdr.DiagnosticEvent[],
  from: string,
  to: string,
  amount: bigint,
  asset: string
) => unknown;

/*
 * RELAXATION 2 -- upstream `validateSimulationEvents`, which returns
 * invalid_exact_stellar_payload_event_not_transfer for ANY contract event
 * whose first topic is not "transfer", from any contract.
 *
 * The spending-limit policy that makes a tab a tab emits
 * `spending_limit_enforced` inside __check_auth on every capped spend
 * (stellar-accounts 0.7.2, policies/spending_limit.rs). Upstream therefore
 * refuses exactly the accounts whose cap is enforced on chain.
 *
 * The narrowing: the upstream check still runs, unchanged, but only over
 * events emitted BY THE ASSET CONTRACT. It still requires exactly one transfer
 * event from the asset, with the expected from, to and amount; a second asset
 * transfer, or a non-transfer event from the asset, is still refused. What it
 * no longer sees is events from other contracts -- the policy's, a verifier's.
 * Those cannot move this asset, and moving the facilitator's own funds needs
 * its authorisation, which the unmodified auth-entry checks refuse.
 */
function onlyAssetEvents(scheme: ExactStellarScheme): void {
  const internals = scheme as unknown as { validateSimulationEvents: EventCheck };
  const upstream = internals.validateSimulationEvents.bind(scheme);

  internals.validateSimulationEvents = (events, from, to, amount, asset) =>
    upstream(
      events.filter((d) => {
        const event = d.event();
        const contractId = event.contractId();
        // xdr.Hash is typed as opaque but is a Buffer at runtime.
        const emitter = contractId ? StrKey.encodeContract(contractId as unknown as Buffer) : null;
        return event.type().name !== "contract" || emitter === asset;
      }),
      from,
      to,
      amount,
      asset
    );
}

/** The scheme with both relaxations. Exported for the test. */
export function smartAccountFacilitatorScheme(signerSecret: string): ExactStellarScheme {
  const scheme = new ExactStellarScheme([createEd25519Signer(signerSecret, X402_NETWORK)], {
    maxTransactionFeeStroops: MAX_TRANSACTION_FEE_STROOPS,
  });
  onlyAssetEvents(scheme);
  return scheme;
}

export function createFacilitator(signerSecret: string): x402Facilitator {
  return new x402Facilitator().register(X402_NETWORK, smartAccountFacilitatorScheme(signerSecret));
}

/* ---- HTTP: the endpoints @x402/core's HTTPFacilitatorClient calls ---------- */

const readJson = async (req: IncomingMessage): Promise<Record<string, never>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

export function facilitatorListener(facilitator: x402Facilitator): RequestListener {
  /*
   * Settlements run one at a time. Upstream settle() loads the signer's
   * sequence number and submits without any lock, so two settlements landing
   * together build the same sequence number and the second is rejected
   * (settle_exact_stellar_transaction_submission_failed) -- which pay_and_fetch
   * must then treat as an unknown outcome. Serialising here costs a few seconds
   * under parallel payments and removes that failure.
   */
  let settling: Promise<unknown> = Promise.resolve();

  return async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    try {
      if (req.method === "GET" && req.url === "/supported") return reply(200, facilitator.getSupported());

      if (req.method === "POST" && (req.url === "/verify" || req.url === "/settle")) {
        const { paymentPayload, paymentRequirements } = await readJson(req);
        if (req.url === "/verify") return reply(200, await facilitator.verify(paymentPayload, paymentRequirements));

        const settled = settling.then(() => facilitator.settle(paymentPayload, paymentRequirements));
        settling = settled.catch(() => undefined);
        return reply(200, await settled);
      }

      reply(404, { error: "not found" });
    } catch (error) {
      reply(500, { error: String((error as Error)?.message ?? error) });
    }
  };
}

/*
 * Entry point. BARKEEP_FACILITATOR_SECRET pays settlement fees and authorises no
 * payment. It must not be the key the MCP server submits open_tab and
 * close_tab with: both would draw on one sequence number, and a settlement
 * racing an open_tab fails one of them. barkeep-testnet-facilitator in the
 * Stellar CLI's key store is the intended key.
 */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const secret = process.env.BARKEEP_FACILITATOR_SECRET;
  if (!secret) throw new Error("BARKEEP_FACILITATOR_SECRET is not set; e.g. $(stellar keys secret barkeep-testnet-facilitator)");

  const signer = keypairFromEnv("BARKEEP_FACILITATOR_SECRET").publicKey();
  const submitter = process.env.BARKEEP_SUBMITTER_SECRET ? keypairFromEnv("BARKEEP_SUBMITTER_SECRET").publicKey() : null;
  if (signer === loadDeployment().deployer || signer === submitter) {
    throw new Error(`refusing to run the facilitator on ${signer}: it is the key open_tab and close_tab submit with`);
  }

  const port = Number(process.env.BARKEEP_FACILITATOR_PORT ?? 4020);
  createServer(facilitatorListener(createFacilitator(secret))).listen(port, "127.0.0.1", () =>
    console.log(`barkeep facilitator on http://127.0.0.1:${port}`)
  );
}
