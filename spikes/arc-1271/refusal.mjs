/*
 * The negative control: the same payment, signed by a key the contract does not
 * know. /verify only -- nothing is settled. Reports what each facilitator says.
 *
 *   node refusal.mjs circle|local
 */

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { circlePost } from "./circle.mjs";
import { NETWORK, USDC, USDC_DOMAIN, account, loadRecord } from "./lib.mjs";

const mode = process.argv[2] ?? "circle";
const seller = account("seller");
const stranger = privateKeyToAccount(generatePrivateKey());
const payer = loadRecord().contracts.throwaway1271.address;

const requirements = { scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller.address, maxTimeoutSeconds: 60, extra: { ...USDC_DOMAIN } };
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme({ address: payer, signTypedData: (t) => stranger.signTypedData(t) }) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: "10000" }] },
});
const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1:4031/haiku", description: "negative control", mimeType: "text/plain" }, accepts: [requirements] });

if (mode === "circle") {
  const { httpStatus, body } = await circlePost(seller, "verify", payload, requirements);
  console.log(JSON.stringify({ facilitator: "circle", signedBy: "a stranger", httpStatus, body }));
} else {
  const r = await fetch("http://127.0.0.1:4030/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }) });
  console.log(JSON.stringify({ facilitator: "local", signedBy: "a stranger", httpStatus: r.status, body: await r.json() }));
}
