import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { x402Facilitator } from "@x402/core/facilitator";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { describe, expect, it } from "vitest";

import { MAX_TRANSACTION_FEE_STROOPS, facilitatorListener, smartAccountFacilitatorScheme } from "./facilitator.ts";

/*
 * The two relaxations, offline. Relaxation 2 reaches a TypeScript-private
 * upstream method, so the first test is the tripwire for an @x402/stellar
 * upgrade that renames or removes it.
 */

const ASSET = "CBXLQ3TCM6EB6KXBYDQVZ3NJO2SAL5FY5BZPMTLGQPROANSSP7RFHP3V";
const POLICY = "CBEILTNYZEE5KX6WTSRON3FCXE7KBYAAUVUWY7TWEUBIEHIY47NVPWBZ";
const OTHER_TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = "CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH";
const SELLER = "GA5SX5BBXI6N6TA3ZWVX5QDRISXWXHIYUDCHG6LKGIY6RUFAMS65AGX2";

type EventCheck = (events: xdr.DiagnosticEvent[], from: string, to: string, amount: bigint, asset: string) => unknown;
const check = (scheme: ExactStellarScheme): EventCheck =>
  (scheme as unknown as { validateSimulationEvents: EventCheck }).validateSimulationEvents;

const event = (contract: string, topic: string, rest: xdr.ScVal[], data: xdr.ScVal) =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(contract) as unknown as xdr.Hash,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol(topic), ...rest], data })),
    }),
  });

const addr = (a: string) => nativeToScVal(a, { type: "address" });
const transfer = (contract: string, amount: bigint) =>
  event(contract, "transfer", [addr(PAYER), addr(SELLER)], nativeToScVal(amount, { type: "i128" }));
/* What the spending-limit policy emits inside __check_auth on every capped spend. */
const policyEvent = event(POLICY, "spending_limit_enforced", [addr(PAYER)], nativeToScVal(1000n, { type: "i128" }));

const secret = Keypair.random().secret();
/** Upstream exactly as the public facilitator runs it: defaults. */
const upstreamScheme = () => new ExactStellarScheme([createEd25519Signer(secret, "stellar:testnet")]);
const reason = (r: unknown) => (r as { invalidReason?: string } | undefined)?.invalidReason;

describe("the facilitator's relaxations", () => {
  it("still finds the upstream private check it narrows", () => {
    expect(typeof check(upstreamScheme())).toBe("function");
  });

  it("raises the fee ceiling above the measured smart-account cost, and keeps one", () => {
    const scheme = smartAccountFacilitatorScheme(secret) as unknown as { maxTransactionFeeStroops: number };
    expect(scheme.maxTransactionFeeStroops).toBe(MAX_TRANSACTION_FEE_STROOPS);
    expect(MAX_TRANSACTION_FEE_STROOPS).toBeGreaterThan(324_039);
    expect(Number.isFinite(MAX_TRANSACTION_FEE_STROOPS)).toBe(true);
  });

  it("upstream refuses a smart-account payment's events; ours accepts them", () => {
    const events = [policyEvent, transfer(ASSET, 1000n)];
    const upstream = upstreamScheme();

    expect(reason(check(upstream).call(upstream, events, PAYER, SELLER, 1000n, ASSET))).toBe(
      "invalid_exact_stellar_payload_event_not_transfer"
    );

    const ours = smartAccountFacilitatorScheme(secret);
    expect(check(ours).call(ours, events, PAYER, SELLER, 1000n, ASSET)).toBeUndefined();
  });

  it("still refuses what the asset contract itself gets wrong", () => {
    const ours = smartAccountFacilitatorScheme(secret);
    const run = (events: xdr.DiagnosticEvent[], amount = 1000n) =>
      reason(check(ours).call(ours, events, PAYER, SELLER, amount, ASSET));

    expect(run([policyEvent, transfer(ASSET, 1000n), transfer(ASSET, 1000n)])).toBe(
      "invalid_exact_stellar_payload_multiple_transfers"
    );
    expect(run([policyEvent, transfer(ASSET, 999n)])).toBe("invalid_exact_stellar_payload_event_wrong_amount");
    expect(run([policyEvent])).toBe("invalid_exact_stellar_payload_no_transfer_events");
    expect(run([event(ASSET, "burn", [addr(PAYER)], nativeToScVal(1n, { type: "i128" })), transfer(ASSET, 1000n)])).toBe(
      "invalid_exact_stellar_payload_event_not_transfer"
    );
    // A transfer of some other token is not the payment, and does not stand in for it.
    expect(run([transfer(OTHER_TOKEN, 1000n)])).toBe("invalid_exact_stellar_payload_no_transfer_events");
  });
});

describe("the facilitator's HTTP listener", () => {
  it("runs settlements one at a time, so they cannot race for the signer's sequence number", async () => {
    let active = 0;
    let peak = 0;
    const fake = {
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true }),
      settle: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 50));
        active--;
        return { success: true, transaction: "tx", network: "stellar:testnet" };
      },
    } as unknown as x402Facilitator;

    const server: Server = createServer(facilitatorListener(fake));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/settle`;
    const body = JSON.stringify({ paymentPayload: {}, paymentRequirements: {} });

    const results = await Promise.all(
      [1, 2, 3].map(() => fetch(url, { method: "POST", body }).then((r) => r.json() as Promise<{ success: boolean }>))
    );
    server.close();

    expect(results.every((r) => r.success)).toBe(true);
    expect(peak).toBe(1);
  });
});
