#![no_std]

//! WebAuthn (secp256r1 passkey) signature verifier contract.
//!
//! As with the Ed25519 verifier, `stellar-accounts` 0.7.2 ships the logic as
//! plain functions in `verifiers::webauthn` and no deployable contract, so this
//! crate gives that logic an address for a smart account to call. The exposed
//! interface matches `VerifierClientInterface`.
//!
//! `sig_data` is `Bytes` holding the XDR of a `WebAuthnSigData`, decoded here
//! with `from_xdr`. It has to be: the account's `authenticate` stores every
//! signature as `Bytes` in `AuthPayload.signers` and passes it to the verifier
//! as that `Bytes` value. The first deployment of this contract
//! (`CBZ5BMHG…F3KL`) took `sig_data: WebAuthnSigData` directly, which the
//! Stellar CLI could call but the account never could: the host refuses to
//! read a `Bytes` value as a map, and the call trapped with
//! `Error(WasmVm, InvalidAction)` before any check ran. Upstream's own example
//! (`examples/multisig-smart-account/webauthn-verifier` at 4529d70) decodes
//! from XDR the same way. See `docs/findings/06-webauthn-verifier-sig-data-not-xdr.md`.
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
//! or User Verified flag unset, bad backup-state combination). `sig_data` that
//! is valid XDR of something other than a `WebAuthnSigData` panics with
//! `SigDataNotXdr` (3120), the one error this crate adds; 3110-3119 are the
//! library's. Bytes that are not XDR at all never reach this code: the host's
//! deserializer traps first with `Error(Value, InvalidInput)`.
//!
//! Note the deliberate gap the library documents: the verifier does NOT validate
//! the origin or the rpIdHash. Binding a credential to an origin is the
//! account's job, and the upstream source recommends an expiry in the signed
//! payload -- which is what the session-key context rule's `valid_until` is for.

use soroban_sdk::{
    contract, contracterror, contractimpl, panic_with_error, xdr::FromXdr, Bytes, BytesN, Env, Vec,
};
use stellar_accounts::verifiers::{
    utils::extract_from_bytes,
    webauthn::{self, WebAuthnError, WebAuthnSigData},
};

/// Errors this crate adds to the library's `WebAuthnError` (3110-3119).
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VerifierError {
    /// `sig_data` did not decode as the XDR of a `WebAuthnSigData`.
    SigDataNotXdr = 3120,
}

#[contract]
pub struct WebAuthnVerifier;

#[contractimpl]
impl WebAuthnVerifier {
    /// Verify a WebAuthn assertion over `hash` for a secp256r1 passkey.
    ///
    /// `sig_data` is the XDR-encoded `WebAuthnSigData { signature,
    /// authenticator_data, client_data }`, as the account passes it.
    pub fn verify(e: &Env, hash: Bytes, key_data: Bytes, sig_data: Bytes) -> bool {
        let sig_data = WebAuthnSigData::from_xdr(e, &sig_data)
            .unwrap_or_else(|_| panic_with_error!(e, VerifierError::SigDataNotXdr));

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
