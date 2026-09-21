/*
 * The fallback path: the stock x402 EVM exact facilitator, unmodified, pointed
 * at Arc Testnet. The relayer key pays gas (in USDC) and authorises no payment.
 * eip6492AllowedFactories is left at its default, so only deployed accounts pay.
 */

import { createServer } from "node:http";

import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { publicActions } from "viem";

import { NETWORK, walletClient } from "./lib.mjs";

const client = walletClient("relayer").extend(publicActions);
const signer = toFacilitatorEvmSigner({
  address: client.account.address,
  readContract: (args) => client.readContract(args),
  verifyTypedData: (args) => client.verifyTypedData(args),
  writeContract: (args) => client.writeContract(args),
  sendTransaction: (args) => client.sendTransaction(args),
  waitForTransactionReceipt: (args) => client.waitForTransactionReceipt(args),
  getCode: (args) => client.getCode(args),
});

const facilitator = new x402Facilitator().register(NETWORK, new ExactEvmScheme(signer));

const readJson = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const port = Number(process.env.SPIKE_LOCAL_FACILITATOR_PORT ?? 4030);
createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && req.url === "/supported") return reply(200, facilitator.getSupported());
    if (req.method === "POST" && (req.url === "/verify" || req.url === "/settle")) {
      const { paymentPayload, paymentRequirements } = await readJson(req);
      const result = req.url === "/verify" ? await facilitator.verify(paymentPayload, paymentRequirements) : await facilitator.settle(paymentPayload, paymentRequirements);
      return reply(200, result);
    }
    reply(404, { error: "not found" });
  } catch (error) {
    reply(500, { error: String(error?.message ?? error) });
  }
}).listen(port, "127.0.0.1", () => console.log(`stock x402 facilitator on http://127.0.0.1:${port}  relayer ${client.account.address}`));
