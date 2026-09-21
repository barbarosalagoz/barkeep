/*
 * A minimal x402 seller on Arc Testnet: EVM exact, USDC at 0x3600…, extra
 * {name:"USDC", version:"2"}. Two facilitators behind it:
 *
 *   SPIKE_FACILITATOR=circle   Circle's Facilitator Service, keyless trial
 *   SPIKE_FACILITATOR=local    the stock x402 facilitator in facilitator.mjs
 *
 * Every facilitator response is appended verbatim to the log named by
 * SPIKE_LOG, because reporting them is what the spike is for.
 */

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";

import { circlePost } from "./circle.mjs";
import { NETWORK, USDC, USDC_DOMAIN, account } from "./lib.mjs";

const mode = process.env.SPIKE_FACILITATOR ?? "circle";
const localUrl = process.env.SPIKE_LOCAL_FACILITATOR_URL ?? "http://127.0.0.1:4030";
const port = Number(process.env.SPIKE_SELLER_PORT ?? 4031);
const logFile = process.env.SPIKE_LOG ?? "seller-log.jsonl";
const seller = account("seller");

/* 0.001 USDC, in the ERC-20 view's 6 decimals. */
const PRICE = process.env.SPIKE_PRICE ?? "1000";

const note = (entry) => {
  appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), facilitator: mode, ...entry })}\n`);
  console.log(JSON.stringify(entry));
};

async function localPost(purpose, paymentPayload, paymentRequirements) {
  const response = await fetch(`${localUrl}/${purpose}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  return { httpStatus: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
}

const post = (purpose, payload, requirements) =>
  mode === "circle" ? circlePost(seller, purpose, payload, requirements) : localPost(purpose, payload, requirements);

createServer(async (req, res) => {
  try {
    if ((req.url ?? "/").split("?")[0] !== "/haiku") return res.writeHead(404).end();

    const requirements = {
      scheme: "exact",
      network: NETWORK,
      asset: USDC,
      amount: PRICE,
      payTo: seller.address,
      maxTimeoutSeconds: 60,
      extra: { ...USDC_DOMAIN },
    };

    const header = req.headers["payment-signature"];
    if (typeof header !== "string") {
      const required = {
        x402Version: 2,
        resource: { url: `http://${req.headers.host}/haiku`, description: "A haiku about finality (0.001 USDC)", mimeType: "text/plain" },
        accepts: [requirements],
      };
      return res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }).end("{}");
    }

    const payload = decodePaymentSignatureHeader(header);
    note({ step: "payload", payload });

    const verify = await post("verify", payload, requirements);
    note({ step: "verify", response: verify });
    if (verify.httpStatus !== 200 || !verify.body.isValid) {
      return res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ stage: "verify", ...verify }));
    }

    const settle = await post("settle", payload, requirements);
    note({ step: "settle", response: settle });
    if (settle.httpStatus !== 200 || !settle.body.success) {
      return res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ stage: "settle", ...settle }));
    }

    res.writeHead(200, { "content-type": "text/plain", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle.body) });
    res.end("Half a second, then /\nnothing left to reorganise -- /\nthe block is the word");
  } catch (error) {
    note({ step: "error", message: String(error?.message ?? error) });
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "seller_error", message: String(error?.message ?? error) }));
  }
}).listen(port, "127.0.0.1", () => console.log(`spike seller on http://127.0.0.1:${port}/haiku  payTo ${seller.address}  facilitator ${mode}`));
