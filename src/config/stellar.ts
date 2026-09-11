/*
 * Network and anchor configuration.
 *
 * Everything that differs between Testnet and Mainnet lives here and is read
 * from Vite env vars (VITE_*) with Testnet defaults. Moving PromptRail to a
 * production anchor is therefore a config change only:
 *
 *   VITE_STELLAR_NETWORK=public
 *   VITE_ANCHOR_HOME_DOMAIN=<the real anchor's home domain>
 *
 * Nothing else in the SEP client names a network, a URL, or an issuer; all of
 * that is discovered from the anchor's stellar.toml (SEP-1) at runtime.
 *
 * This module is shared by the Vite app, the Vitest suite and the Node demo
 * script, so env lookup checks import.meta.env first and falls back to
 * process.env.
 */

import { Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "testnet" | "public";

type EnvRecord = Record<string, string | undefined>;

/** Read an env var from Vite (import.meta.env) or Node (process.env). */
export function readEnv(name: string): string | undefined {
  const viteEnv = (import.meta as { env?: EnvRecord }).env;
  const fromVite = viteEnv?.[name];

  if (typeof fromVite === "string" && fromVite.length > 0) {
    return fromVite;
  }

  const nodeEnv = (globalThis as { process?: { env?: EnvRecord } }).process
    ?.env;
  const fromNode = nodeEnv?.[name];

  if (typeof fromNode === "string" && fromNode.length > 0) {
    return fromNode;
  }

  return undefined;
}

export function parseNetwork(value: string | undefined): StellarNetwork {
  if (value === undefined || value === "") {
    return "testnet";
  }

  const normalized = value.trim().toLowerCase();

  if (
    normalized === "public" ||
    normalized === "pubnet" ||
    normalized === "mainnet"
  ) {
    return "public";
  }

  if (normalized === "testnet") {
    return "testnet";
  }

  throw new Error(
    `Unsupported VITE_STELLAR_NETWORK "${value}" (use "testnet" or "public").`
  );
}

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export const STELLAR_NETWORK: StellarNetwork = parseNetwork(
  readEnv("VITE_STELLAR_NETWORK")
);

export const NETWORK_PASSPHRASE: string =
  STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

export const NETWORK_LABEL: string =
  STELLAR_NETWORK === "public" ? "Stellar Mainnet" : "Stellar Testnet";

export const HORIZON_URL: string =
  readEnv("VITE_HORIZON_URL") ??
  (STELLAR_NETWORK === "public"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org");

export const EXPLORER_BASE_URL = `https://stellar.expert/explorer/${STELLAR_NETWORK}`;

export const explorerTxUrl = (hash: string): string =>
  `${EXPLORER_BASE_URL}/tx/${hash}`;

export const explorerAccountUrl = (account: string): string =>
  `${EXPLORER_BASE_URL}/account/${account}`;

/** Friendbot only exists on Testnet. */
export const FRIENDBOT_URL: string | null =
  STELLAR_NETWORK === "testnet" ? "https://friendbot.stellar.org" : null;

/* ------------------------------------------------------------------ */
/* Anchor (TRY on/off-ramp via SEP-1/10/6/38)                          */
/* ------------------------------------------------------------------ */

/** Home domain whose stellar.toml describes the anchor. */
export const ANCHOR_HOME_DOMAIN: string =
  readEnv("VITE_ANCHOR_HOME_DOMAIN") ?? "tr-mock-anchor.fly.dev";

/** On-chain asset the anchor ramps (issuer is discovered from the toml). */
export const ANCHOR_ASSET_CODE: string =
  readEnv("VITE_ANCHOR_ASSET_CODE") ?? "USDC";

/** Off-chain fiat leg, as an ISO 4217 code. */
export const ANCHOR_FIAT_CODE: string =
  readEnv("VITE_ANCHOR_FIAT_CODE") ?? "TRY";

/**
 * Sandbox anchors let the client "play the bank" by simulating the incoming
 * fiat transfer. Enabled by default off Mainnet; never on Mainnet.
 */
export const ANCHOR_SANDBOX: boolean =
  STELLAR_NETWORK !== "public" &&
  (readEnv("VITE_ANCHOR_SANDBOX") ?? "true").toLowerCase() !== "false";
