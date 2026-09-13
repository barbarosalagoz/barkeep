/*
 * The x402 `exact` client scheme, paying FROM the smart account.
 *
 * Same wire output as @x402/stellar's client ExactStellarScheme -- a base64
 * transaction invoking transfer(from, to, amount) on the asset, with its one
 * auth entry signed -- but the entry is authorised through Chain.signAs, so the
 * signature is the account's AuthPayload under the tab's context rule rather
 * than a classic ed25519 signature. The stock client cannot produce that
 * (deployments/testnet.json, doneTests.x402Spike.T1).
 *
 * Signing here is not paying. The facilitator rebuilds the envelope and
 * submits; this module only proves, by simulating with the signed entry, that
 * the account's __check_auth and the spending-limit policy accept it. A tab
 * over its cap is refused at that simulation with Error(Contract, #3221), so
 * nothing is sent to the seller.
 */

import { Account, BASE_FEE, Keypair, Operation, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

import type { Chain } from "./chain.ts";

export const X402_NETWORK = "stellar:testnet";

/** Placeholder source, as the stock client uses: the facilitator replaces it. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** Testnet closes a ledger roughly every 5 seconds. */
const SECONDS_PER_LEDGER = 5;

/* The refusals a tab payment meets, as the account and policy report them. */
const REFUSALS: Record<string, string> = {
  "3000": "ContextRuleNotFound -- the tab is closed",
  "3002": "UnvalidatedContext -- the tab has expired",
  "3221": "SpendingLimitExceeded -- over the tab's remaining cap",
};

/** The contract error from a simulation failure, not the whole diagnostic event log. */
export function contractRefusal(simulationError: string): string {
  const code = /Error\(Contract, #(\d+)\)/.exec(simulationError)?.[1];
  if (!code) return simulationError.split("\n")[0];
  return `Error(Contract, #${code})${REFUSALS[code] ? ` ${REFUSALS[code]}` : ""}`;
}

export interface SmartAccountSchemeOptions {
  agent: Keypair;
  contextRuleId: number;
  /** The only asset the tab's rule can move: CallContract(token). */
  token: string;
  /** Per-call cap in base units. Checked again here, after the caller's check. */
  maxAmount: bigint;
}

export function smartAccountExactScheme(chain: Chain, opts: SmartAccountSchemeOptions): SchemeNetworkClient {
  return {
    scheme: "exact",

    async createPaymentPayload(x402Version: number, req: PaymentRequirements): Promise<PaymentPayloadResult> {
      if (req.network !== X402_NETWORK) throw new Error(`refusing network ${req.network}; testnet only`);
      if (req.asset !== opts.token) throw new Error(`refusing asset ${req.asset}; the tab can only move ${opts.token}`);
      if (BigInt(req.amount) > opts.maxAmount) {
        throw new Error(`price ${req.amount} exceeds max_amount ${opts.maxAmount} (base units)`);
      }

      const latest = await chain.latestLedger();
      const expiry = latest + Math.ceil(req.maxTimeoutSeconds / SECONDS_PER_LEDGER);

      const build = (auth?: xdr.SorobanAuthorizationEntry[]) =>
        new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: chain.network })
          .addOperation(
            Operation.invokeContractFunction({
              contract: req.asset,
              function: "transfer",
              args: [
                nativeToScVal(chain.smartAccount, { type: "address" }),
                nativeToScVal(req.payTo, { type: "address" }),
                nativeToScVal(BigInt(req.amount), { type: "i128" }),
              ],
              ...(auth ? { auth } : {}),
            })
          )
          .setTimeout(req.maxTimeoutSeconds)
          .build();

      // Recording mode: learn which entry the account must sign. Runs no __check_auth.
      const recording = await chain.server.simulateTransaction(build());
      if (rpc.Api.isSimulationError(recording)) throw new Error(`simulation failed: ${recording.error}`);

      const signed = await Promise.all(
        (recording.result?.auth ?? []).map((entry) =>
          authorizeEntry(entry, chain.signAs(opts.agent, opts.contextRuleId), expiry, chain.network)
        )
      );

      // Enforcing mode: __check_auth and the policy run. Cap and expiry refusals surface here.
      const withAuth = build(signed);
      const enforcing = await chain.server.simulateTransaction(withAuth);
      if (rpc.Api.isSimulationError(enforcing)) throw new Error(`refused by the account: ${contractRefusal(enforcing.error)}`);

      const tx = rpc.assembleTransaction(withAuth, enforcing).build();
      return { x402Version, payload: { transaction: tx.toXDR() } };
    },
  };
}
