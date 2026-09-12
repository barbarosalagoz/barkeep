#![no_std]

//! The Barkeep smart account: the tab.
//!
//! **This contract is not audited.** `docs/ARCHITECTURE-v2.md` §4.1 states the
//! position exactly. `stellar-accounts` 0.7.2 supplies the storage, context-rule
//! and authorisation logic, and OpenZeppelin audited that library in-house at
//! v0.7.0-rc.1 — four tags behind the 0.7.2 pinned here. None of the audits
//! cover this file.
//!
//! `SmartAccount` is a trait whose methods all have default bodies delegating to
//! `stellar_accounts::smart_account::storage`, so the work here is to expose
//! them through `#[contractimpl]` and to implement `__check_auth`. Every
//! administrative method requires authorisation from the account itself, which
//! means an auth entry signed by a signer on a matching context rule.
//!
//! Hence the constructor: it installs the first rule directly through `storage`,
//! bypassing the `require_auth` the trait defaults perform, because before that
//! rule exists there is no signer who could authorise creating it.

use soroban_sdk::{
    auth::{Context, CustomAccountInterface},
    contract, contractimpl,
    crypto::Hash,
    Address, Env, Map, String, Symbol, Val, Vec,
};
// The #[contractimpl(contracttrait)] expansion names these in generated code.
use stellar_accounts::smart_account::{
    add_context_rule, do_check_auth, AuthPayload, ContextRule, ContextRuleType,
    ExecutionEntryPoint, Signer, SmartAccount, SmartAccountError,
};

#[contract]
pub struct BarkeepSmartAccount;

/*
 * Both traits are #[contracttrait], so #[contractimpl(contracttrait)] exports
 * every default method as a contract function. Hand-delegating them would add
 * a wrapper per method with nothing to say.
 */
#[contractimpl(contracttrait)]
impl SmartAccount for BarkeepSmartAccount {}

#[contractimpl(contracttrait)]
impl ExecutionEntryPoint for BarkeepSmartAccount {}

#[contractimpl]
impl BarkeepSmartAccount {
    /// Installs the account's first context rule: a `Default` rule holding the
    /// human signer, with no expiry.
    ///
    /// `Default` matches any context, so this rule is what authorises later
    /// administration -- adding the agent's session-key rule, installing a
    /// policy. It is deliberately the only rule created here, and it goes in
    /// through `add_context_rule` rather than the trait method because the
    /// trait method requires auth from an account that has no signers yet.
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
    /// supplied signature against `sha256(signature_payload ||
    /// context_rule_ids.to_xdr())`, and then runs each matched rule's policies.
    ///
    /// The digest binds the rule selection, so a signature collected for one
    /// rule cannot be replayed to select a laxer one.
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
