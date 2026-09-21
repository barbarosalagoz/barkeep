/*
 * Shared by the spike's scripts: keys, clients, the contract build, and the
 * record in deployments/arc-testnet.json. Arc Testnet only.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import solc from "solc";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

export const NETWORK = "eip155:5042002";
export const CHAIN_ID = 5042002;
export const RPC_URL = process.env.ARC_TESTNET_RPC ?? "https://rpc.testnet.arc.io";
export const EXPLORER = "https://explorer.testnet.arc.io";
/* The ERC-20 view of native USDC: 6 decimals here, 18 as gas. */
export const USDC = "0x3600000000000000000000000000000000000000";
export const USDC_DOMAIN = { name: "USDC", version: "2" };

/* viem's built-in arcTestnet still points at rpc.testnet.arc.network. */
export const arcTestnet = defineChain({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "Arc explorer", url: EXPLORER } },
});

export const explorerTx = (hash) => `${EXPLORER}/tx/${hash}`;

/* Throwaway Testnet keys, kept out of the repository. */
const KEYS = join(homedir(), ".local/state/barkeep/arc-testnet-keys.json");
export const keys = () => JSON.parse(readFileSync(KEYS, "utf8"));
export const account = (name) => privateKeyToAccount(keys()[name].privateKey);

export const publicClient = () => createPublicClient({ chain: arcTestnet, transport: http(RPC_URL) });
export const walletClient = (name) => createWalletClient({ account: account(name), chain: arcTestnet, transport: http(RPC_URL) });

export const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "v", type: "uint256" }], outputs: [{ type: "bool" }] },
];

export function compile(name = "Throwaway1271") {
  const source = readFileSync(join(here, `contracts/${name}.sol`), "utf8");
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { [`${name}.sol`]: { content: source } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
      })
    )
  );
  const errors = (out.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[`${name}.sol`][name];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`, solc: solc.version() };
}

/* ---- deployments/arc-testnet.json ---------------------------------------- */

const RECORD = join(here, "../../deployments/arc-testnet.json");

export function loadRecord() {
  if (existsSync(RECORD)) return JSON.parse(readFileSync(RECORD, "utf8"));
  return {
    network: NETWORK,
    chainId: CHAIN_ID,
    rpcUrl: RPC_URL,
    explorer: EXPLORER,
    note: "Throwaway spike: does an x402 facilitator on Arc Testnet accept an ERC-1271 payer? Testnet only; keys live outside the repository.",
    usdc: USDC,
    accounts: {},
    contracts: {},
    transactions: [],
    doneTests: {},
  };
}

export function saveRecord(record) {
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
}

/** Appends one transaction, read back from the chain rather than trusted. */
export async function recordTx(hash, what, extra = {}) {
  const receipt = await publicClient().waitForTransactionReceipt({ hash });
  const record = loadRecord();
  record.transactions.push({
    what,
    hash,
    explorer: explorerTx(hash),
    status: receipt.status,
    block: Number(receipt.blockNumber),
    from: receipt.from,
    to: receipt.to,
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    at: new Date().toISOString(),
    ...extra,
  });
  saveRecord(record);
  return receipt;
}
