/*
 * Key handling.
 *
 * The admin and submitter keys reach this process through the environment and
 * are never written anywhere by it. Agent session keys are made per tab and
 * kept in their own directory (agentKeys.ts), never in the state directory,
 * which holds public values only -- see state.ts.
 *
 * Storing a spending key next to the metadata that describes what it can spend
 * is worth avoiding, which is why the agent-key directory is separate from the
 * state directory rather than inside it as docs/ARCHITECTURE-v2.md §5 sketched.
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
