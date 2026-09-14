#![no_std]

//! Barkeep policy contracts for OpenZeppelin smart accounts.
//!
//! **This contract is not audited.** See `docs/ARCHITECTURE-v2.md` §4.1.
//!
//! `SpendingLimitPolicy` gives `stellar_accounts::policies::spending_limit` an
//! address, the same way the verifier crates do for the verifiers: the library
//! ships the logic as plain functions and no deployable contract, and a smart
//! account reaches a policy by address through `PolicyClient`.
//!
//! The rolling window is the library's: it stores
//! `{spending_limit, period_ledgers, spending_history, cached_total_spent}` per
//! (account, context-rule), evicts entries older than the window before each
//! check, and panics with `SpendingLimitExceeded` (3221) when the transfer would
//! take the period total past the cap. Three limits inherited from it, all
//! documented upstream and repeated here because they shape the product:
//!
//! - Only `fn_name == "transfer"` is handled, reading the amount from
//!   `args.get(2)`. Any other function on the rule is refused with `NotAllowed`
//!   (3223), so `transfer_from`, burns and DEX routes are unusable through a
//!   capped rule rather than uncounted. Restrictive, but safe.
//! - `install` refuses a rule that is not `ContextRuleType::CallContract`
//!   (`OnlyCallContractAllowed`, 3227).
//! - `period_ledgers` cannot be changed after install; a different window means
//!   reinstalling the policy on that rule.
//!
//! What caps *who* the tab can pay is a separate contract,
//! `contracts/barkeep-payee-allowlist`, installed on the same rule.
//! `stellar-accounts` 0.7.2 ships only `simple_threshold`,
//! `weighted_threshold` and `spending_limit`, so the allowlist was written by
//! us, and is unaudited like every other contract this repo deploys (§4,
//! §10 risk 1).

use soroban_sdk::{contract, contractimpl, Address, Env, Val, Vec};
use stellar_accounts::{
    policies::{spending_limit, Policy},
    smart_account::{ContextRule, Signer},
};

#[contract]
pub struct SpendingLimitPolicy;

impl Policy for SpendingLimitPolicy {
    type AccountParams = spending_limit::SpendingLimitAccountParams;

    fn enforce(
        e: &Env,
        context: soroban_sdk::auth::Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        spending_limit::enforce(e, &context, &authenticated_signers, &context_rule, &smart_account)
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        spending_limit::install(e, &install_params, &context_rule, &smart_account)
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        spending_limit::uninstall(e, &context_rule, &smart_account)
    }
}

#[contractimpl]
impl SpendingLimitPolicy {
    /// Runs before every transfer on a rule this policy is installed on.
    /// Panics with `SpendingLimitExceeded` (3221) if the cap would be passed.
    pub fn enforce(
        e: &Env,
        context: soroban_sdk::auth::Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        <Self as Policy>::enforce(e, context, authenticated_signers, context_rule, smart_account)
    }

    /// Called by the account when the policy is added to a rule.
    pub fn install(
        e: &Env,
        install_params: Val,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        let params: spending_limit::SpendingLimitAccountParams =
            soroban_sdk::IntoVal::into_val(&install_params, e);

        <Self as Policy>::install(e, params, context_rule, smart_account)
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        <Self as Policy>::uninstall(e, context_rule, smart_account)
    }

    /// Current window state for a rule: limit, period, history and total spent.
    pub fn get_spending_limit_data(
        e: &Env,
        context_rule_id: u32,
        smart_account: Address,
    ) -> spending_limit::SpendingLimitData {
        spending_limit::get_spending_limit_data(e, context_rule_id, &smart_account)
    }
}

#[cfg(test)]
mod test;
