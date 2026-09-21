/*
 * The 97-byte case: deploys Wrapped1271 (once), funds it, and pays the seller's
 * price from it through one facilitator, calling /verify then /settle directly.
 *
 *   node wrapped.mjs circle|local
 */

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { concat, keccak256, parseUnits, toHex } from "viem";

import { circlePost } from "./circle.mjs";
import { ERC20_ABI, NETWORK, USDC, USDC_DOMAIN, account, compile, loadRecord, publicClient, recordTx, saveRecord, walletClient } from "./lib.mjs";

const mode = process.argv[2] ?? "circle";
const pc = publicClient();
const owner = walletClient("owner");
const seller = account("seller");
const tag = keccak256(toHex("barkeep tab context"));

let record = loadRecord();
if (!record.contracts.wrapped1271) {
  const built = compile("Wrapped1271");
  const hash = await owner.deployContract({ abi: built.abi, bytecode: built.bytecode, args: [owner.account.address, tag] });
  const receipt = await recordTx(hash, "deploy Wrapped1271");
  const fund = await owner.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [receipt.contractAddress, parseUnits("0.1", 6)] });
  await recordTx(fund, "fund the Wrapped1271 contract", { amount: "0.1 USDC" });
  record = loadRecord();
  record.contracts.wrapped1271 = { address: receipt.contractAddress, owner: owner.account.address, tag, signatureBytes: 97, source: "spikes/arc-1271/contracts/Wrapped1271.sol", solc: built.solc, deployTx: hash };
  saveRecord(record);
}
const payer = record.contracts.wrapped1271.address;

const requirements = { scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller.address, maxTimeoutSeconds: 60, extra: { ...USDC_DOMAIN } };
const signer = { address: payer, signTypedData: async (t) => concat([await owner.account.signTypedData(t), tag]) };
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(signer) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: "10000" }] },
});
const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1:4031/haiku", description: "97-byte 1271 signature", mimeType: "text/plain" }, accepts: [requirements] });

const post = async (purpose) => {
  if (mode === "circle") {
    const { httpStatus, body } = await circlePost(seller, purpose, payload, requirements);
    return { httpStatus, body };
  }
  const r = await fetch(`http://127.0.0.1:4030/${purpose}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }) });
  return { httpStatus: r.status, body: await r.json() };
};

const verify = await post("verify");
console.log(JSON.stringify({ facilitator: mode, payer, signatureBytes: (payload.payload.signature.length - 2) / 2, step: "verify", ...verify }));
const settle = await post("settle");
console.log(JSON.stringify({ facilitator: mode, step: "settle", ...settle }));
