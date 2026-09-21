/*
 * Pays the seller from the ERC-1271 contract with the STOCK x402 client. The
 * only thing that is ours is the signer: its address is the contract, so the
 * contract is `from` in transferWithAuthorization, and the owner key signs the
 * typed data. The contract's isValidSignature takes that 65-byte signature over
 * the digest as is; there is no further wrapping to do for this account.
 *
 *   node pay.mjs [url]      default http://127.0.0.1:4031/haiku
 */

import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";

import { NETWORK, USDC, account, loadRecord } from "./lib.mjs";

const url = process.argv[2] ?? "http://127.0.0.1:4031/haiku";
const owner = account("owner");
const payer = loadRecord().contracts.throwaway1271?.address;
if (!payer) throw new Error("no contract in deployments/arc-testnet.json; run deploy.mjs first");

const signer = { address: payer, signTypedData: (typed) => owner.signTypedData(typed) };
/* Arc's USDC is not in x402's default asset table, so it is allowed by name, with a per-payment ceiling. */
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: "10000" }] },
});

const first = await fetch(url);
if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
const required = decodePaymentRequiredHeader(first.headers.get("PAYMENT-REQUIRED"));

const payload = await client.createPaymentPayload(required);
const second = await fetch(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });

const paid = second.headers.get("PAYMENT-RESPONSE");
console.log(
  JSON.stringify(
    {
      payer,
      signedBy: owner.address,
      authorization: payload.payload.authorization,
      signatureBytes: (payload.payload.signature.length - 2) / 2,
      httpStatus: second.status,
      paymentResponse: paid ? decodePaymentResponseHeader(paid) : null,
      body: await second.text(),
    },
    null,
    2
  )
);
