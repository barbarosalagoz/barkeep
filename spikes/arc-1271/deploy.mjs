/*
 * Deploys the throwaway ERC-1271 account from the owner key, gives it a little
 * USDC to pay with, gives the relayer a little for gas, and checks that the
 * deployed contract accepts the owner's signature and refuses a stranger's.
 * Every transaction is recorded in deployments/arc-testnet.json.
 */

import { keccak256, parseUnits, toHex } from "viem";
import { generatePrivateKey, serializeSignature, sign } from "viem/accounts";

import { ERC20_ABI, USDC, account, compile, keys, loadRecord, publicClient, recordTx, saveRecord, walletClient } from "./lib.mjs";

const pc = publicClient();
const owner = walletClient("owner");
const built = compile();

let record = loadRecord();
record.accounts = Object.fromEntries(Object.entries(keys()).map(([name, k]) => [name, k.address]));
saveRecord(record);

if (!record.contracts.throwaway1271) {
  const hash = await owner.deployContract({ abi: built.abi, bytecode: built.bytecode, args: [owner.account.address] });
  const receipt = await recordTx(hash, "deploy Throwaway1271");
  record = loadRecord();
  record.contracts.throwaway1271 = { address: receipt.contractAddress, owner: owner.account.address, source: "spikes/arc-1271/contracts/Throwaway1271.sol", solc: built.solc, deployTx: hash };
  saveRecord(record);
}
const contract = record.contracts.throwaway1271.address;
console.log("contract", contract);

const top = async (to, amount, what) => {
  const have = await pc.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [to] });
  if (have >= parseUnits(amount, 6) / 2n) return;
  const hash = await owner.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "transfer", args: [to, parseUnits(amount, 6)] });
  await recordTx(hash, what, { amount: `${amount} USDC` });
};
await top(contract, "1", "fund the 1271 contract");
await top(account("relayer").address, "2", "fund the self-hosted facilitator's relayer (gas)");

/* The account as the chain sees it: the owner's signature passes, a stranger's does not. */
const digest = keccak256(toHex("barkeep arc 1271 spike"));
const check = async (privateKey) =>
  pc.readContract({ address: contract, abi: built.abi, functionName: "isValidSignature", args: [digest, serializeSignature(await sign({ hash: digest, privateKey }))] });
const result = { owner: await check(keys().owner.privateKey), stranger: await check(generatePrivateKey()) };
console.log("isValidSignature", result);
if (result.owner !== "0x1626ba7e" || result.stranger !== "0xffffffff") throw new Error("the contract does not behave as an ERC-1271 account");

record = loadRecord();
record.doneTests.isValidSignature = { at: new Date().toISOString(), digest, ownerSignature: result.owner, strangerSignature: result.stranger };
saveRecord(record);
