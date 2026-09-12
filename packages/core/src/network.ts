/*
 * The Stellar network primitive: which network, parsed from a name, and the
 * passphrase that identifies it.
 *
 * These belong here rather than in a consumer's config because both consumers
 * need them and none of them touches @stellar/* — see index.ts for why that
 * matters. Everything *around* them (reading env vars, Horizon and explorer
 * URLs, anchor settings) is consumer configuration and stays in the consumer.
 */

/** Stellar networks Barkeep runs against. */
export type StellarNetwork = "testnet" | "public";

/*
 * Network passphrases, as plain strings.
 *
 * These are the values of Networks.PUBLIC and Networks.TESTNET in
 * @stellar/stellar-sdk. They are protocol constants, fixed since 2015, and
 * inlining them is what lets the network primitive live here instead of
 * pulling an SDK across the version boundary index.ts describes.
 */
export const NETWORK_PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  public: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

/** The passphrase for a network, by name. */
export const networkPassphrase = (network: StellarNetwork): string =>
  NETWORK_PASSPHRASES[network];

/**
 * Parse a configured network name, accepting the spellings people actually
 * write. Unset, empty and whitespace-only all mean Testnet, which is the safe
 * default: trimming happens before the empty check so a value that is only
 * whitespace is treated as absent rather than as a misconfiguration.
 *
 * `source` names what supplied the value, so a caller reading an env var can
 * still produce "Unsupported VITE_STELLAR_NETWORK ..." without this module
 * having to know that Vite, or env vars, exist.
 */
export function parseNetwork(
  value: string | undefined,
  source = "network"
): StellarNetwork {
  if (value === undefined) {
    return "testnet";
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "") {
    return "testnet";
  }

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
    `Unsupported ${source} "${value}" (use "testnet" or "public").`
  );
}
