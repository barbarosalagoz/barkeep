/*
 * Key handling.
 *
 * Secrets reach this process through the environment and are never written to
 * the state directory, the repository, or a log. The state directory holds
 * public values only -- see state.ts.
 *
 * This is a deliberate departure from docs/ARCHITECTURE-v2.md §5, which puts
 * "the session key" in the plugin data directory. Storing a spending key next
 * to the metadata that describes what it can spend is worth avoiding while the
 * alternative costs one environment variable.
 */

import { Keypair, StrKey } from "@stellar/stellar-sdk";

/** The 32-byte public key a Signer::External record stores, from a G... address. */
export function rawEd25519Key(publicKey: string): Uint8Array {
  return Uint8Array.from(StrKey.decodeEd25519PublicKey(publicKey));
}

export function keypairFromEnv(name: string): Keypair {
  const secret = process.env[name];

  if (!secret) {
    throw new Error(
      `${name} is not set. Barkeep reads signing keys from the environment and ` +
        `never stores them; e.g. ${name}=$(stellar keys secret <identity>)`
    );
  }

  try {
    return Keypair.fromSecret(secret);
  } catch {
    // Deliberately does not echo the value.
    throw new Error(`${name} is not a valid Stellar secret key`);
  }
}
