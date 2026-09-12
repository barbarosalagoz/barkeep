#![no_std]

//! The Barkeep smart account, on `stellar-accounts` at commit `4529d70`.
//!
//! **This contract is not audited.** `docs/ARCHITECTURE-v2.md` §4.1 states the
//! position for the deployed 0.7.2 account, and it is worse here: `4529d70` is
//! an unpublished commit on OpenZeppelin's `v0.9.0` branch, after every audit.
//!
//! It is `barkeep-smart-account` with one upstream change underneath it:
//! OpenZeppelin/stellar-contracts#868. Signers no longer sign
//! `sha256(signature_payload || context_rule_ids.to_xdr())`; they commit to an
//! `AuthDigestPreimage { account, signature_payload, context_rule_ids }`, which
//! binds the account address as well as the rule selection. That closes
//! ARCHITECTURE-v2 §10 risk 13. The 0.7.2 crate stays deployed and recorded
//! beside this one.
//!
//! As before, `SmartAccount` is a trait whose methods have default bodies
//! delegating to `stellar_accounts::smart_account::storage`, and the constructor
//! installs the first rule directly because nobody could authorise it yet.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, BytesN, Env, Map, String, Symbol, Val, Vec,
};
// The #[contractimpl(contracttrait)] expansion names these in generated code.
// AuthDigestPreimage is new at 4529d70: the trait gained an auth_digest view
// taking one, and the macro re-emits that signature here.
use stellar_accounts::smart_account::{
    add_context_rule, do_check_auth, AuthDigestPreimage, AuthPayload, ContextRule,
    ContextRuleType, ExecutionEntryPoint, Signer, SmartAccount, SmartAccountError,
};

#[contract]
pub struct BarkeepSmartAccount;

/*
 * Both traits are #[contracttrait], so #[contractimpl(contracttrait)] exports
 * every default method as a contract function -- including auth_digest, the
 * view a client simulates to check its own digest encoding.
 */
#[contractimpl(contracttrait)]
impl SmartAccount for BarkeepSmartAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for BarkeepSmartAccount {}

#[contractimpl]
impl BarkeepSmartAccount {
    /// Installs the account's first context rule: a `Default` rule holding the
    /// human signer, with no expiry. See `barkeep-smart-account` for why it is
    /// the only rule created here.
    pub fn __constructor(e: &Env, admin_signer: Signer, name: String) {
        add_context_rule(
            e,
            &ContextRuleType::Default,
            &name,
            None,
            &Vec::from_array(e, [admin_signer]),
            &Map::new(e),
        );
    }
}

#[contractimpl]
impl CustomAccountInterface for BarkeepSmartAccount {
    type Signature = AuthPayload;
    type Error = SmartAccountError;

    /// Validates each context against the rule named for it, authenticates every
    /// supplied signature against
    /// `AuthDigestPreimage { account: this contract, signature_payload,
    /// context_rule_ids }` -- External signers over `sha256(preimage.to_xdr())`,
    /// Delegated signers through `require_auth_for_args((preimage,))` -- and
    /// then runs each matched rule's policies.
    fn __check_auth(
        e: Env,
        signature_payload: Hash<32>,
        signatures: AuthPayload,
        auth_contexts: Vec<Context>,
    ) -> Result<(), SmartAccountError> {
        do_check_auth(&e, &signature_payload, &signatures, &auth_contexts)
    }
}

#[cfg(test)]
mod test;
