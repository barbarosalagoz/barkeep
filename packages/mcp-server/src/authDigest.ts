/*
 * The smart account's authorisation digest, and the AuthPayload around it.
 *
 * A client that wants to authorise anything on a Barkeep smart account has to
 * reproduce one hash byte-for-byte:
 *
 *   auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
 *
 * Signers sign THAT, never the raw signature_payload the host hands them.
 * Binding the rule ids into the digest is what stops a signature gathered for
 * one context rule being replayed to select a laxer one -- sign for the capped
 * agent rule, submit against the unrestricted admin rule.
 *
 * stellar-accounts 0.7.2 ships no client-side helper for this
 * (docs/ARCHITECTURE-v2.md §14 q5), so this is ours. The encoding is pinned
 * against the contract itself: contracts/barkeep-smart-account/src/test.rs
 * emits vectors from Soroban's own Vec<u32>::to_xdr and sha256, and
 * authDigest.test.ts asserts this module reproduces them. If either side
 * drifts, one of the two fails.
 *
 * This module lives in @barkeep/mcp and not @barkeep/core because it needs
 * @stellar/stellar-sdk for XDR, and core may not depend on it.
 */

import { Address, hash, xdr } from "@stellar/stellar-sdk";

/** A signer as the account stores it: `Signer` in stellar-accounts. */
export type Signer =
  /** Verification delegated to another contract's own auth. */
  | { kind: "delegated"; address: string }
  /** An external verifier contract plus the public key data it verifies. */
  | { kind: "external"; verifier: string; keyData: Uint8Array };

export interface SignedSigner {
  signer: Signer;
  /** Raw signature bytes, in whatever shape the verifier expects. */
  signature: Uint8Array;
}

/**
 * `context_rule_ids` as Soroban serialises it: an ScVal vec of ScVal u32.
 *
 * Soroban's `Vec<u32>::to_xdr` produces the ScVal encoding, not a bare XDR
 * array, so the discriminants are part of the preimage.
 */
export function contextRuleIdsToXdr(contextRuleIds: readonly number[]): Buffer {
  for (const id of contextRuleIds) {
    if (!Number.isInteger(id) || id < 0 || id > 0xffff_ffff) {
      throw new RangeError(`context rule id must be a u32, got ${id}`);
    }
  }

  return xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
}

/**
 * The digest every signer on this authorisation must sign.
 *
 * @param signaturePayload the 32-byte payload the host provides to __check_auth
 * @param contextRuleIds one rule id per auth context, in the same order
 */
export function authDigest(
  signaturePayload: Uint8Array,
  contextRuleIds: readonly number[]
): Buffer {
  if (signaturePayload.length !== 32) {
    throw new RangeError(
      `signature payload must be 32 bytes, got ${signaturePayload.length}`
    );
  }

  return hash(
    Buffer.concat([Buffer.from(signaturePayload), contextRuleIdsToXdr(contextRuleIds)])
  );
}

/** A `Signer` as an ScVal: the contracttype enum is a vec of [tag, ...args]. */
export function signerToScVal(signer: Signer): xdr.ScVal {
  if (signer.kind === "delegated") {
    return xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("Delegated"),
      Address.fromString(signer.address).toScVal(),
    ]);
  }

  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(signer.verifier).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(signer.keyData)),
  ]);
}

/**
 * The `AuthPayload` struct passed to `__check_auth`.
 *
 * A #[contracttype] struct is an ScVal map keyed by field name, and the host
 * requires those keys in sorted order -- "context_rule_ids" before "signers".
 */
export function buildAuthPayload(
  signed: readonly SignedSigner[],
  contextRuleIds: readonly number[]
): xdr.ScVal {
  const signers = signed.map(({ signer, signature }) => {
    return new xdr.ScMapEntry({
      key: signerToScVal(signer),
      val: xdr.ScVal.scvBytes(Buffer.from(signature)),
    });
  });

  /*
   * Map keys must be in ScVal sort order. Sorting by the serialised bytes is
   * the encoding's own ordering, so it stays correct as signer shapes change.
   */
  signers.sort((a, b) => Buffer.compare(a.key().toXDR(), b.key().toXDR()));

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap(signers),
    }),
  ]);
}
