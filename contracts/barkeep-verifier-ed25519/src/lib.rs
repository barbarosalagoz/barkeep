#![no_std]

//! Ed25519 signature verifier contract.
//!
//! `stellar-accounts` 0.7.2 ships the verification *logic* as plain functions in
//! `verifiers::ed25519`, not as a deployable contract: there is no `#[contract]`
//! anywhere in the crate outside its own tests. A smart account reaches a
//! verifier by address, through the `VerifierClient` generated from
//! `VerifierClientInterface`, so the three functions below exist to give that
//! logic an address. They are a thin delegation and deliberately hold no state.
//!
//! The exposed interface matches `VerifierClientInterface` exactly:
//!
//! ```text
//! fn verify(hash: Bytes, key_data: Val, sig_data: Val) -> bool
//! fn canonicalize_key(key_data: Val) -> Bytes
//! fn batch_canonicalize_key(key_data: Vec<Val>) -> Vec<Bytes>
//! ```
//!
//! `verify` returns `true` or does not return: the host's `ed25519_verify`
//! panics with `Error(Crypto, InvalidInput)` on a bad signature rather than
//! returning `false`. Callers get a failed transaction, not a `false`.

use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::ed25519;

#[contract]
pub struct Ed25519Verifier;

#[contractimpl]
impl Ed25519Verifier {
    /// Verify `sig_data` over `hash` for the 32-byte Ed25519 public key.
    pub fn verify(e: &Env, hash: Bytes, key_data: BytesN<32>, sig_data: BytesN<64>) -> bool {
        ed25519::verify(e, &hash, &key_data, &sig_data)
    }

    /// Canonical bytes of an Ed25519 public key (identity for signer storage).
    pub fn canonicalize_key(e: &Env, key_data: BytesN<32>) -> Bytes {
        ed25519::canonicalize_key(e, &key_data)
    }

    /// Batched `canonicalize_key`; output order matches input.
    pub fn batch_canonicalize_key(e: &Env, key_data: Vec<BytesN<32>>) -> Vec<Bytes> {
        ed25519::batch_canonicalize_key(e, &key_data)
    }
}

#[cfg(test)]
mod test;
