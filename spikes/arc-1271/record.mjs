/*
 * Records a settlement in deployments/arc-testnet.json after reading it back
 * from the chain: the transaction must have succeeded, called one of USDC's
 * two transferWithAuthorization overloads (bytes signature, or v,r,s), and
 * moved the amount from one of the recorded 1271 contracts to the seller.
 *
 *   node record.mjs <hash> <label>
 */

import { decodeFunctionData, parseAbi, parseEventLogs } from "viem";

import { USDC, account, loadRecord, publicClient, recordTx } from "./lib.mjs";

const [hash, label] = process.argv.slice(2);
const pc = publicClient();
const abi = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

const tx = await pc.getTransaction({ hash });
const receipt = await pc.getTransactionReceipt({ hash });
const call = decodeFunctionData({ abi, data: tx.input });
const payers = Object.values(loadRecord().contracts).map((c) => c.address.toLowerCase());
const seller = account("seller").address;

const moved = parseEventLogs({ abi, logs: receipt.logs, eventName: "Transfer" }).filter(
  (l) => l.address.toLowerCase() === USDC && payers.includes(l.args.from.toLowerCase()) && l.args.to === seller
);
if (receipt.status !== "success" || tx.to.toLowerCase() !== USDC || moved.length !== 1) throw new Error("the chain does not show this payment");

await recordTx(hash, label, {
  selector: tx.input.slice(0, 10),
  relayer: tx.from,
  payer: call.args[0],
  payTo: call.args[1],
  amount: `${moved[0].args.value} base units (6 decimals)`,
  overload: call.args.length === 7 ? "bytes signature" : "v,r,s",
  feeUsdc: Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18,
});
console.log("recorded", hash, "relayer", tx.from, "selector", tx.input.slice(0, 10), "moved", moved[0].args.value, "fee USDC", Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18);
