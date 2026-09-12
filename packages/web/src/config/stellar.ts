/*
 * Network and anchor configuration.
 *
 * Everything that differs between Testnet and Mainnet lives here and is read
 * from Vite env vars (VITE_*) with Testnet defaults. Moving Barkeep to a
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

import { NETWORK_PASSPHRASES, parseNetwork } from "@barkeep/core";
import type { StellarNetwork } from "@barkeep/core";

export type { StellarNetwork };

type EnvRecord = Record<string, string | undefined>;

/*
 * Named reads only, one expression per variable.
 *
 * Vite replaces each `import.meta.env.VITE_*` expression with its literal
 * value at build time. Reading `import.meta.env` as an object instead makes
 * Vite inline EVERY variable it knows, which on Vercel includes the git
 * commit message, the commit author, and the project and deployment ids.
 *
 * The reads are wrapped because `import.meta.env` does not exist when this
 * module runs under plain Node (scripts/sep-demo.ts).
 */
function viteValue(read: () => unknown): string | undefined {
  try {
    const value = read();

    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The only variables that may reach the browser bundle. */
const VITE_ENV: EnvRecord = {
  VITE_STELLAR_NETWORK: viteValue(() => import.meta.env.VITE_STELLAR_NETWORK),
  VITE_HORIZON_URL: viteValue(() => import.meta.env.VITE_HORIZON_URL),
  VITE_ANCHOR_HOME_DOMAIN: viteValue(() => import.meta.env.VITE_ANCHOR_HOME_DOMAIN),
  VITE_ANCHOR_ASSET_CODE: viteValue(() => import.meta.env.VITE_ANCHOR_ASSET_CODE),
  VITE_ANCHOR_FIAT_CODE: viteValue(() => import.meta.env.VITE_ANCHOR_FIAT_CODE),
  VITE_ANCHOR_SANDBOX: viteValue(() => import.meta.env.VITE_ANCHOR_SANDBOX),
};

/** Read an env var from Vite (named keys only) or Node (process.env). */
export function readEnv(name: string): string | undefined {
  const fromVite = VITE_ENV[name];

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

/* ------------------------------------------------------------------ */
/* Network                                                             */
/* ------------------------------------------------------------------ */

export const STELLAR_NETWORK: StellarNetwork = parseNetwork(
  readEnv("VITE_STELLAR_NETWORK"),
  "VITE_STELLAR_NETWORK"
);

export const NETWORK_PASSPHRASE: string = NETWORK_PASSPHRASES[STELLAR_NETWORK];

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
