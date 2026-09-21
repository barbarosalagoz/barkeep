/*
 * How far does the keyless trial go? Settles 0.001 USDC payments from the 1271
 * contract through Circle, one at a time, until /settle stops succeeding or
 * SPIKE_TRIAL_MAX is reached. Every settled hash is checked on chain and kept in
 * deployments/arc-testnet.json under doneTests.circleTrial.
 */

import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";

import { circlePost } from "./circle.mjs";
import { NETWORK, USDC, USDC_DOMAIN, account, explorerTx, loadRecord, publicClient, saveRecord } from "./lib.mjs";

const max = Number(process.env.SPIKE_TRIAL_MAX ?? 60);
const seller = account("seller");
const owner = account("owner");
const pc = publicClient();
const payer = loadRecord().contracts.throwaway1271.address;

const requirements = { scheme: "exact", network: NETWORK, asset: USDC, amount: "1000", payTo: seller.address, maxTimeoutSeconds: 60, extra: { ...USDC_DOMAIN } };
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactEvmScheme({ address: payer, signTypedData: (t) => owner.signTypedData(t) }) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: "10000" }] },
});

const save = (patch) => {
  const record = loadRecord();
  record.doneTests.circleTrial = { ...(record.doneTests.circleTrial ?? { payTo: seller.address, earlierSettlements: 1, settlements: [] }), ...patch };
  saveRecord(record);
};

const settlements = loadRecord().doneTests.circleTrial?.settlements ?? [];
let stoppedBy = null;
for (let i = settlements.length; i < max; i++) {
  const payload = await client.createPaymentPayload({ x402Version: 2, resource: { url: "http://127.0.0.1:4031/haiku", description: "trial allowance probe", mimeType: "text/plain" }, accepts: [requirements] });
  const { httpStatus, body } = await circlePost(seller, "settle", payload, requirements);
  if (httpStatus !== 200 || !body.success) {
    stoppedBy = { afterSettlements: settlements.length + 1, httpStatus, body };
    break;
  }
  const receipt = await pc.waitForTransactionReceipt({ hash: body.transaction });
  settlements.push({ hash: body.transaction, explorer: explorerTx(body.transaction), status: receipt.status, block: Number(receipt.blockNumber) });
  save({ settlements, at: new Date().toISOString() });
  console.log(settlements.length + 1, body.transaction, receipt.status);
}
save({ settlements, stoppedBy, at: new Date().toISOString() });
console.log(JSON.stringify({ totalSettledOnThisPayTo: settlements.length + 1, stoppedBy }));
