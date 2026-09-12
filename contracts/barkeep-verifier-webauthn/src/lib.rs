#![no_std]

//! WebAuthn (secp256r1 passkey) signature verifier contract.
//!
//! As with the Ed25519 verifier, `stellar-accounts` 0.7.2 ships the logic as
//! plain functions in `verifiers::webauthn` and no deployable contract, so this
//! crate gives that logic an address for a smart account to call. The exposed
//! interface matches `VerifierClientInterface`.
//!
//! `key_data` is `Bytes`, not `BytesN<65>`: WebAuthn key data is the 65-byte
//! uncompressed secp256r1 point optionally followed by the credential id. The
//! credential id is metadata, not key identity, so `canonicalize_key` strips it
//! and `verify` takes the 65-byte prefix. Passing the suffix through would make
//! the same passkey register as two different signers.
//!
//! `verify` returns `true` or does not return: `secp256r1_verify` panics on a
//! bad signature, and the library's own validations panic with `WebAuthnError`
//! for a malformed ceremony (wrong type field, challenge mismatch, User Present
//! or User Verified flag unset, bad backup-state combination).
//!
//! Note the deliberate gap the library documents: the verifier does NOT validate
//! the origin or the rpIdHash. Binding a credential to an origin is the
//! account's job, and the upstream source recommends an expiry in the signed
//! payload -- which is what the session-key context rule's `valid_until` is for.

use soroban_sdk::{contract, contractimpl, panic_with_error, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{
    webauthn::{self, WebAuthnError, WebAuthnSigData},
    utils::extract_from_bytes,
};

#[contract]
pub struct WebAuthnVerifier;

#[contractimpl]
impl WebAuthnVerifier {
    /// Verify a WebAuthn assertion over `hash` for a secp256r1 passkey.
    pub fn verify(e: &Env, hash: Bytes, key_data: Bytes, sig_data: WebAuthnSigData) -> bool {
        let public_key: BytesN<65> = extract_from_bytes(e, &key_data, 0..65)
            .unwrap_or_else(|| panic_with_error!(e, WebAuthnError::KeyDataInvalid));

        webauthn::verify(e, &hash, &public_key, &sig_data)
    }

    /// Canonical bytes of a passkey: the 65-byte point, credential id stripped.
    pub fn canonicalize_key(e: &Env, key_data: Bytes) -> Bytes {
        webauthn::canonicalize_key(e, &key_data)
    }

    /// Batched `canonicalize_key`; output order matches input.
    pub fn batch_canonicalize_key(e: &Env, key_data: Vec<Bytes>) -> Vec<Bytes> {
        webauthn::batch_canonicalize_key(e, &key_data)
    }
}

#[cfg(test)]
mod test;
