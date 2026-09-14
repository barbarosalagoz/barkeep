#![no_std]

//! Barkeep's payee-allowlist policy: caps *who* a tab can pay.
//!
//! **This contract is not audited.** It is ours, not OpenZeppelin's:
//! `stellar-accounts` 0.7.2 ships only `simple_threshold`, `weighted_threshold`
//! and `spending_limit`, so this policy was written in this repository, is
//! reviewed by nobody outside it, and runs on Testnet only, like everything
//! else we deploy. `docs/ARCHITECTURE-v2.md` §4.1 states the position exactly.
//! The upstream audits cover none of this file.
//!
//! It is installed on the tab's context rule next to `spending_limit`. The
//! account runs every policy on a rule and any one of them panicking refuses
//! the authorisation, so the two compose as AND: a transfer must be under the
//! cap *and* to a listed payee.
//!
//! # What it enforces
//!
//! - The rule must be `ContextRuleType::CallContract` (`install` refuses
//!   anything else, 3905), which pins it to one token contract.
//! - The authorised call must be `transfer(from, to, amount)`. The payee is
//!   `args.get(1)`, and must decode as an `Address` that is on the list, or the
//!   authorisation is refused with `PayeeNotAllowed` (3901). Any other function,
//!   a malformed `to`, or a muxed destination is refused with `NotAllowed`
//!   (3903). Fail closed: what this policy cannot read, it does not allow.
//! - At least one of the rule's signers must have authenticated (3903). The
//!   account skips its own "every signer matched" check on a rule that has
//!   policies and defers to them (`get_validated_context_by_id` in 0.7.2), so a
//!   policy that did not check this would let an unsigned call through on a
//!   rule where it was the only policy.
//!
//! # Fail closed on the list itself
//!
//! An empty list does not mean "anyone". `install` refuses an empty list
//! (3902), and `remove_payee` refuses to remove the last entry (3902); to stop
//! a tab paying anyone, close it. A tab that may pay anyone is a tab this policy
//! is *not installed on*, and Barkeep's `open_tab` only builds one when the
//! caller says `allow_any_payee: true` explicitly.
//!
//! # Who can change the list
//!
//! `add_payee` and `remove_payee` require the smart account's authorisation for
//! a call to *this contract*. A tab's rule is `CallContract(<token>)`, so the
//! agent's session key cannot select a rule that matches that context: the
//! account refuses with `UnvalidatedContext` (3002) on the tab's rule because
//! the context type does not match, and with the same 3002 on rule 0 because
//! that rule has no policies and so needs its own signer, which the agent is
//! not. In the Barkeep account that leaves rule 0's human signer. This
//! is a property of the account's rules, not of this contract: a rule scoped to
//! `CallContract(<this policy>)` holding the agent key would let it edit lists.
//!
//! # Events
//!
//! `enforce` emits **nothing**. `spending_limit` emits `spending_limit_enforced`
//! from inside `__check_auth`, and upstream `@x402/stellar`'s facilitator
//! refuses a payment whose simulation carries any contract event other than
//! the asset's `transfer` (`invalid_exact_stellar_payload_event_not_transfer`).
//! Barkeep's facilitator filters to events emitted by the asset contract, so it
//! would tolerate one from this policy; a third-party facilitator would not.
//! An event here would be a second reason for them to refuse, and it would say
//! nothing the payment does not already say: the `transfer` event names the
//! payee that passed, and a refused payee reverts the transaction, which
//! discards any event it emitted. Only the list's lifecycle is published --
//! install, uninstall, add, remove -- and those happen in the human signer's
//! transactions, never inside a payment.
//!
//! # Error codes
//!
//! 3900-3908. `stellar-contracts` uses 3000-3606 for its account, verifier and
//! policy modules; 39xx keeps a refusal from this contract distinguishable
//! from theirs when a diagnostic shows only `Error(Contract, #N)`.

use soroban_sdk::{
    auth::{Context, ContractContext},
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, Address, Env, TryFromVal, Val, Vec,
};
use stellar_accounts::{
    policies::Policy,
    smart_account::{ContextRule, ContextRuleType, Signer},
};

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum PayeeAllowlistError {
    /// No allowlist is installed for this smart account and context rule.
    SmartAccountNotInstalled = 3900,
    /// The transfer's destination is not on the rule's allowlist.
    PayeeNotAllowed = 3901,
    /// The list would be empty. An empty list is refused, never read as "anyone".
    EmptyAllowlist = 3902,
    /// Not a `transfer(from, to, amount)` with a readable `to`, or no signer
    /// on the rule authenticated.
    NotAllowed = 3903,
    /// An allowlist is already installed for this smart account and rule.
    AlreadyInstalled = 3904,
    /// Only a `CallContract` context rule can carry an allowlist.
    OnlyCallContractAllowed = 3905,
    /// More than `MAX_PAYEES` entries.
    TooManyPayees = 3906,
    /// The payee is already on the list.
    DuplicatePayee = 3907,
    /// The payee is not on the list.
    PayeeNotFound = 3908,
}

/// Installation parameters: the payees the rule may transfer to.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PayeeAllowlistAccountParams {
    pub payees: Vec<Address>,
}

#[contracttype]
pub enum PayeeAllowlistStorageKey {
    /// The allowlist of a smart account's context rule.
    AccountContext(Address, u32),
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PayeeAllowlistInstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub payees: Vec<Address>,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PayeeAllowlistUninstalled {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PayeeAdded {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub payee: Address,
}

#[contractevent]
#[derive(Clone, Debug)]
pub struct PayeeRemoved {
    #[topic]
    pub smart_account: Address,
    pub context_rule_id: u32,
    pub payee: Address,
}

/// Bounds the list's storage and the linear scan in `enforce`.
pub const MAX_PAYEES: u32 = 20;

const DAY_IN_LEDGERS: u32 = 17280;
/// Same TTL policy as the library's spending limit, so the two entries of one
/// tab age together.
pub const PAYEE_ALLOWLIST_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const PAYEE_ALLOWLIST_TTL_THRESHOLD: u32 = PAYEE_ALLOWLIST_EXTEND_AMOUNT - DAY_IN_LEDGERS;

fn key(smart_account: &Address, context_rule_id: u32) -> PayeeAllowlistStorageKey {
    PayeeAllowlistStorageKey::AccountContext(smart_account.clone(), context_rule_id)
}

fn read(e: &Env, smart_account: &Address, context_rule_id: u32) -> Vec<Address> {
    let k = key(smart_account, context_rule_id);
    e.storage()
        .persistent()
        .get(&k)
        .inspect(|_| {
            e.storage().persistent().extend_ttl(
                &k,
                PAYEE_ALLOWLIST_TTL_THRESHOLD,
                PAYEE_ALLOWLIST_EXTEND_AMOUNT,
            );
        })
        .unwrap_or_else(|| panic_with_error!(e, PayeeAllowlistError::SmartAccountNotInstalled))
}

/// The destination of a `transfer(from, to, amount)` context, or a refusal.
fn transfer_destination(e: &Env, context: &Context) -> Address {
    if let Context::Contract(ContractContext { fn_name, args, .. }) = context {
        if fn_name == &symbol_short!("transfer") && args.len() == 3 {
            if let Some(to) = args.get(1) {
                if let Ok(to) = Address::try_from_val(e, &to) {
                    return to;
                }
            }
        }
    }
    panic_with_error!(e, PayeeAllowlistError::NotAllowed)
}

fn validate_new_list(e: &Env, payees: &Vec<Address>) {
    if payees.is_empty() {
        panic_with_error!(e, PayeeAllowlistError::EmptyAllowlist)
    }
    if payees.len() > MAX_PAYEES {
        panic_with_error!(e, PayeeAllowlistError::TooManyPayees)
    }
    for (i, payee) in payees.iter().enumerate() {
        if payees.first_index_of(&payee) != Some(i as u32) {
            panic_with_error!(e, PayeeAllowlistError::DuplicatePayee)
        }
    }
}

#[contract]
pub struct PayeeAllowlistPolicy;

impl Policy for PayeeAllowlistPolicy {
    type AccountParams = PayeeAllowlistAccountParams;

    fn enforce(
        e: &Env,
        context: Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if authenticated_signers.is_empty() {
            panic_with_error!(e, PayeeAllowlistError::NotAllowed)
        }

        let payee = transfer_destination(e, &context);

        if !read(e, &smart_account, context_rule.id).contains(&payee) {
            panic_with_error!(e, PayeeAllowlistError::PayeeNotAllowed)
        }
        // No event: see "Events" in the crate docs.
    }

    fn install(
        e: &Env,
        install_params: Self::AccountParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        smart_account.require_auth();

        if !matches!(context_rule.context_type, ContextRuleType::CallContract(_)) {
            panic_with_error!(e, PayeeAllowlistError::OnlyCallContractAllowed)
        }

        let payees = install_params.payees;
        validate_new_list(e, &payees);

        let k = key(&smart_account, context_rule.id);
        if e.storage().persistent().has(&k) {
            panic_with_error!(e, PayeeAllowlistError::AlreadyInstalled)
        }
        e.storage().persistent().set(&k, &payees);

        PayeeAllowlistInstalled { smart_account, context_rule_id: context_rule.id, payees }
            .publish(e);
    }

    fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        smart_account.require_auth();

        let k = key(&smart_account, context_rule.id);
        if !e.storage().persistent().has(&k) {
            panic_with_error!(e, PayeeAllowlistError::SmartAccountNotInstalled)
        }
        e.storage().persistent().remove(&k);

        PayeeAllowlistUninstalled { smart_account, context_rule_id: context_rule.id }.publish(e);
    }
}

#[contractimpl]
impl PayeeAllowlistPolicy {
    /// Runs before every authorisation on a rule this policy is installed on.
    /// Panics with `PayeeNotAllowed` (3901) if the transfer's `to` is not listed.
    pub fn enforce(
        e: &Env,
        context: Context,
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
        let params: PayeeAllowlistAccountParams =
            soroban_sdk::IntoVal::into_val(&install_params, e);

        <Self as Policy>::install(e, params, context_rule, smart_account)
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        <Self as Policy>::uninstall(e, context_rule, smart_account)
    }

    /// Add a payee. Needs the smart account's authorisation for this call,
    /// which a tab's `CallContract(<token>)` rule cannot give.
    pub fn add_payee(e: &Env, context_rule_id: u32, payee: Address, smart_account: Address) {
        smart_account.require_auth();

        let mut payees = read(e, &smart_account, context_rule_id);
        if payees.contains(&payee) {
            panic_with_error!(e, PayeeAllowlistError::DuplicatePayee)
        }
        if payees.len() >= MAX_PAYEES {
            panic_with_error!(e, PayeeAllowlistError::TooManyPayees)
        }
        payees.push_back(payee.clone());
        e.storage().persistent().set(&key(&smart_account, context_rule_id), &payees);

        PayeeAdded { smart_account, context_rule_id, payee }.publish(e);
    }

    /// Remove a payee. Refuses to remove the last one (3902): close the tab
    /// instead. Same authorisation as `add_payee`.
    pub fn remove_payee(e: &Env, context_rule_id: u32, payee: Address, smart_account: Address) {
        smart_account.require_auth();

        let mut payees = read(e, &smart_account, context_rule_id);
        let Some(index) = payees.first_index_of(&payee) else {
            panic_with_error!(e, PayeeAllowlistError::PayeeNotFound)
        };
        if payees.len() == 1 {
            panic_with_error!(e, PayeeAllowlistError::EmptyAllowlist)
        }
        payees.remove(index);
        e.storage().persistent().set(&key(&smart_account, context_rule_id), &payees);

        PayeeRemoved { smart_account, context_rule_id, payee }.publish(e);
    }

    /// The rule's allowlist. Panics with 3900 if none is installed.
    pub fn get_payees(e: &Env, context_rule_id: u32, smart_account: Address) -> Vec<Address> {
        read(e, &smart_account, context_rule_id)
    }
}

#[cfg(test)]
mod test;
