extern crate std;

use barkeep_policy::{SpendingLimitPolicy, SpendingLimitPolicyClient};
use barkeep_smart_account::{BarkeepSmartAccount, BarkeepSmartAccountClient};
use barkeep_verifier_ed25519::Ed25519Verifier;
use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{
    auth::{Context, ContractContext},
    symbol_short,
    testutils::{Address as _, Events as _, Ledger as _, MuxedAddress as _},
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, Error, IntoVal, InvokeError, Map, MuxedAddress, String, Symbol,
    Val, Vec,
};
use stellar_accounts::{
    policies::spending_limit::SpendingLimitAccountParams,
    smart_account::{AuthPayload, ContextRuleType, Signer},
};

use crate::{
    PayeeAllowlistAccountParams, PayeeAllowlistError, PayeeAllowlistPolicy,
    PayeeAllowlistPolicyClient, MAX_PAYEES,
};

/*
 * Most of these tests run the ACCOUNT's __check_auth, not the policy alone.
 *
 * The account is the real barkeep-smart-account, its human signer and the
 * agent are real ed25519 keys behind the real verifier, and the tab's rule
 * carries the real spending-limit policy and this allowlist together -- the
 * shape open_tab builds on Testnet. try_invoke_contract_check_auth hands the
 * account a payload, a signed AuthPayload and the contexts, exactly what the
 * host does for a transfer, so the refusals below are the account's decisions
 * with both policies in the loop.
 *
 * Setup calls (adding rules) use mock_all_auths; it does not reach
 * try_invoke_contract_check_auth, which always runs the account's code.
 */

const ADMIN_SK: [u8; 32] = [1u8; 32];
const AGENT_SK: [u8; 32] = [2u8; 32];

const CAP: i128 = 5_000;
const ADMIN_RULE: u32 = 0;

struct Tab {
    e: Env,
    account: Address,
    verifier: Address,
    token: Address,
    allowlist: Address,
    spending: Address,
    rule: u32,
    payee: Address,
    stranger: Address,
}

fn signer(e: &Env, verifier: &Address, sk: &[u8; 32]) -> Signer {
    let pk = SigningKey::from_bytes(sk).verifying_key().to_bytes();
    Signer::External(verifier.clone(), Bytes::from_array(e, &pk))
}

fn allowlist_params(e: &Env, payees: &[&Address]) -> Val {
    let mut v = Vec::new(e);
    for p in payees {
        v.push_back((*p).clone());
    }
    PayeeAllowlistAccountParams { payees: v }.into_val(e)
}

fn tab_with(payees: &[usize], policies: &[&str]) -> Tab {
    let e = Env::default();
    e.mock_all_auths();
    // Not 0: the rolling window evicts entries at or below current - period,
    // which at ledger 0 is every entry.
    e.ledger().set_sequence_number(100_000);

    let verifier = e.register(Ed25519Verifier, ());
    let spending = e.register(SpendingLimitPolicy, ());
    let allowlist = e.register(PayeeAllowlistPolicy, ());
    // Any contract address serves as the token: the account matches the
    // context's contract against CallContract(token) and never calls it.
    let token = Address::generate(&e);
    let account = e.register(
        BarkeepSmartAccount,
        (signer(&e, &verifier, &ADMIN_SK), String::from_str(&e, "admin")),
    );

    let payee = Address::generate(&e);
    let stranger = Address::generate(&e);
    let candidates = [&payee, &stranger];

    let mut map: Map<Address, Val> = Map::new(&e);
    for p in policies {
        match *p {
            "spending" => map.set(
                spending.clone(),
                SpendingLimitAccountParams { spending_limit: CAP, period_ledgers: 720 }.into_val(&e),
            ),
            "allowlist" => map.set(
                allowlist.clone(),
                allowlist_params(&e, &payees.iter().map(|i| candidates[*i]).collect::<std::vec::Vec<_>>()),
            ),
            _ => unreachable!(),
        }
    }

    let rule = BarkeepSmartAccountClient::new(&e, &account).add_context_rule(
        &ContextRuleType::CallContract(token.clone()),
        &String::from_str(&e, "agent"),
        &None,
        &Vec::from_array(&e, [signer(&e, &verifier, &AGENT_SK)]),
        &map,
    );

    Tab { e, account, verifier, token, allowlist, spending, rule: rule.id, payee, stranger }
}

/// The tab open_tab builds: spending limit and allowlist on one rule, payee listed.
fn tab() -> Tab {
    tab_with(&[0], &["spending", "allowlist"])
}

fn transfer(t: &Tab, to: Val, amount: i128) -> Context {
    Context::Contract(ContractContext {
        contract: t.token.clone(),
        fn_name: symbol_short!("transfer"),
        args: Vec::from_array(&t.e, [t.account.to_val(), to, amount.into_val(&t.e)]),
    })
}

fn call(t: &Tab, contract: &Address, fn_name: &str, args: Vec<Val>) -> Context {
    Context::Contract(ContractContext {
        contract: contract.clone(),
        fn_name: Symbol::new(&t.e, fn_name),
        args,
    })
}

/// Sign `context` as `sk` selecting `rule`, and run the account's __check_auth.
fn authorise(t: &Tab, context: Context, rule: u32, sk: Option<&[u8; 32]>) -> Result<(), Result<Error, InvokeError>> {
    let e = &t.e;
    let payload = BytesN::<32>::from_array(e, &[7u8; 32]);
    let rule_ids = Vec::from_array(e, [rule]);

    // auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
    let mut preimage = Bytes::from_array(e, &payload.to_array());
    preimage.append(&rule_ids.clone().to_xdr(e));
    let digest = e.crypto().sha256(&preimage).to_array();

    let mut signers = Map::new(e);
    if let Some(sk) = sk {
        let sig = SigningKey::from_bytes(sk).sign(&digest).to_bytes();
        signers.set(signer(e, &t.verifier, sk), Bytes::from_array(e, &sig));
    }

    e.try_invoke_contract_check_auth::<Error>(
        &t.account,
        &payload,
        AuthPayload { signers, context_rule_ids: rule_ids }.into_val(e),
        &Vec::from_array(e, [context]),
    )
}

fn refused_with(code: u32) -> Result<(), Result<Error, InvokeError>> {
    Err(Ok(Error::from_contract_error(code)))
}

fn spent(t: &Tab) -> i128 {
    SpendingLimitPolicyClient::new(&t.e, &t.spending)
        .get_spending_limit_data(&t.rule, &t.account)
        .cached_total_spent
}

/* ---- composition with spending_limit on the same rule -------------------- */

#[test]
fn allowlisted_payee_under_the_cap_is_authorised() {
    let t = tab();

    assert_eq!(authorise(&t, transfer(&t, t.payee.to_val(), 1_000), t.rule, Some(&AGENT_SK)), Ok(()));
    assert_eq!(spent(&t), 1_000);
}

#[test]
fn an_authorised_payment_carries_no_event_from_the_allowlist() {
    /*
     * The decision in the crate docs, pinned: a payment's simulation must not
     * gain a contract event from this policy, because upstream x402
     * facilitators refuse any non-transfer event. spending_limit's own event
     * is still there -- that one is the library's, and is why a third-party
     * facilitator refuses a tab regardless.
     */
    let t = tab();
    assert_eq!(authorise(&t, transfer(&t, t.payee.to_val(), 1_000), t.rule, Some(&AGENT_SK)), Ok(()));

    let events = t.e.events().all();
    assert!(!events.filter_by_contract(&t.spending).events().is_empty(), "spending_limit_enforced should be present");
    assert!(events.filter_by_contract(&t.allowlist).events().is_empty(), "the allowlist emitted an event during enforce");
}

#[test]
fn under_the_cap_but_not_allowlisted_is_refused() {
    let t = tab();

    assert_eq!(
        authorise(&t, transfer(&t, t.stranger.to_val(), 1_000), t.rule, Some(&AGENT_SK)),
        refused_with(PayeeAllowlistError::PayeeNotAllowed as u32)
    );
    // The spending limit may have run first; the refusal rolls its write back.
    assert_eq!(spent(&t), 0);
}

#[test]
fn allowlisted_but_over_the_cap_is_refused() {
    let t = tab();

    assert_eq!(
        authorise(&t, transfer(&t, t.payee.to_val(), CAP + 1), t.rule, Some(&AGENT_SK)),
        refused_with(3221) // SpendingLimitExceeded
    );
    assert_eq!(spent(&t), 0);
}

#[test]
fn the_cap_still_counts_across_allowlisted_payments() {
    let t = tab();

    assert_eq!(authorise(&t, transfer(&t, t.payee.to_val(), 3_000), t.rule, Some(&AGENT_SK)), Ok(()));
    assert_eq!(
        authorise(&t, transfer(&t, t.payee.to_val(), 3_000), t.rule, Some(&AGENT_SK)),
        refused_with(3221)
    );
    assert_eq!(spent(&t), 3_000);
}

#[test]
fn over_the_cap_and_not_allowlisted_is_refused() {
    let t = tab();

    assert!(authorise(&t, transfer(&t, t.stranger.to_val(), CAP + 1), t.rule, Some(&AGENT_SK)).is_err());
}

/* ---- the list can only be changed by the human signer -------------------- */

fn add_payee_context(t: &Tab, payee: &Address) -> Context {
    call(
        t,
        &t.allowlist,
        "add_payee",
        Vec::from_array(&t.e, [t.rule.into_val(&t.e), payee.to_val(), t.account.to_val()]),
    )
}

#[test]
fn the_agent_key_cannot_authorise_add_payee_on_its_own_rule() {
    let t = tab();

    // The tab's rule is CallContract(token); add_payee is a call to the policy.
    assert_eq!(
        authorise(&t, add_payee_context(&t, &t.stranger), t.rule, Some(&AGENT_SK)),
        refused_with(3002) // UnvalidatedContext
    );
}

#[test]
fn the_agent_key_cannot_authorise_add_payee_on_the_admin_rule() {
    let t = tab();

    assert_eq!(
        authorise(&t, add_payee_context(&t, &t.stranger), ADMIN_RULE, Some(&AGENT_SK)),
        // Rule 0 has no policies, so the account requires every one of its
        // signers matched; the agent is not one: UnvalidatedContext.
        refused_with(3002)
    );
}

#[test]
fn the_human_signer_can_authorise_add_payee() {
    let t = tab();

    assert_eq!(authorise(&t, add_payee_context(&t, &t.stranger), ADMIN_RULE, Some(&ADMIN_SK)), Ok(()));
}

#[test]
fn an_added_payee_becomes_payable_and_a_removed_one_stops_being() {
    let t = tab();
    let policy = PayeeAllowlistPolicyClient::new(&t.e, &t.allowlist);

    policy.add_payee(&t.rule, &t.stranger, &t.account);
    assert_eq!(policy.get_payees(&t.rule, &t.account), Vec::from_array(&t.e, [t.payee.clone(), t.stranger.clone()]));
    assert_eq!(authorise(&t, transfer(&t, t.stranger.to_val(), 1_000), t.rule, Some(&AGENT_SK)), Ok(()));

    policy.remove_payee(&t.rule, &t.payee, &t.account);
    assert_eq!(
        authorise(&t, transfer(&t, t.payee.to_val(), 1_000), t.rule, Some(&AGENT_SK)),
        refused_with(PayeeAllowlistError::PayeeNotAllowed as u32)
    );
}

#[test]
fn add_and_remove_require_the_accounts_authorisation() {
    let t = tab();
    t.e.set_auths(&[]);
    let policy = PayeeAllowlistPolicyClient::new(&t.e, &t.allowlist);

    assert!(policy.try_add_payee(&t.rule, &t.stranger, &t.account).is_err());
    assert!(policy.try_remove_payee(&t.rule, &t.payee, &t.account).is_err());
    assert!(t.e.auths().is_empty());
}

/* ---- fail closed ---------------------------------------------------------- */

/// Add a rule carrying only the allowlist, built from `params` in the tab's Env.
fn install_error(params: impl Fn(&Tab) -> (std::vec::Vec<Address>, ContextRuleType)) -> Result<Error, InvokeError> {
    let t = tab_with(&[], &["spending"]);
    let (payees, context_type) = params(&t);
    let mut map: Map<Address, Val> = Map::new(&t.e);
    map.set(t.allowlist.clone(), allowlist_params(&t.e, &payees.iter().collect::<std::vec::Vec<_>>()));

    BarkeepSmartAccountClient::new(&t.e, &t.account)
        .try_add_context_rule(
            &context_type,
            &String::from_str(&t.e, "agent"),
            &None,
            &Vec::from_array(&t.e, [signer(&t.e, &t.verifier, &AGENT_SK)]),
            &map,
        )
        .map(|_| ())
        .expect_err("install should have been refused")
}

fn contract_error(e: PayeeAllowlistError) -> Result<Error, InvokeError> {
    Ok(Error::from_contract_error(e as u32))
}

#[test]
fn install_refuses_an_empty_list() {
    assert_eq!(
        install_error(|t| (std::vec![], ContextRuleType::CallContract(t.token.clone()))),
        contract_error(PayeeAllowlistError::EmptyAllowlist)
    );
}

#[test]
fn install_refuses_a_rule_that_is_not_call_contract() {
    assert_eq!(
        install_error(|t| (std::vec![t.payee.clone()], ContextRuleType::Default)),
        contract_error(PayeeAllowlistError::OnlyCallContractAllowed)
    );
}

#[test]
fn install_refuses_duplicates_and_oversized_lists() {
    assert_eq!(
        install_error(|t| (std::vec![t.payee.clone(), t.payee.clone()], ContextRuleType::CallContract(t.token.clone()))),
        contract_error(PayeeAllowlistError::DuplicatePayee)
    );
    assert_eq!(
        install_error(|t| {
            let many = (0..=MAX_PAYEES).map(|_| Address::generate(&t.e)).collect();
            (many, ContextRuleType::CallContract(t.token.clone()))
        }),
        contract_error(PayeeAllowlistError::TooManyPayees)
    );
}

#[test]
fn removing_the_last_payee_is_refused() {
    let t = tab();
    let policy = PayeeAllowlistPolicyClient::new(&t.e, &t.allowlist);

    assert_eq!(
        policy.try_remove_payee(&t.rule, &t.payee, &t.account),
        Err(Ok(Error::from_contract_error(PayeeAllowlistError::EmptyAllowlist as u32)))
    );
    assert_eq!(
        policy.try_remove_payee(&t.rule, &t.stranger, &t.account),
        Err(Ok(Error::from_contract_error(PayeeAllowlistError::PayeeNotFound as u32)))
    );
}

#[test]
fn a_non_transfer_call_on_the_rule_is_refused() {
    let t = tab_with(&[0], &["allowlist"]);
    let approve = call(
        &t,
        &t.token,
        "approve",
        Vec::from_array(&t.e, [t.account.to_val(), t.payee.to_val(), 1_000i128.into_val(&t.e), 100u32.into_val(&t.e)]),
    );

    assert_eq!(
        authorise(&t, approve, t.rule, Some(&AGENT_SK)),
        refused_with(PayeeAllowlistError::NotAllowed as u32)
    );
}

#[test]
fn a_muxed_destination_is_refused_even_when_its_account_is_listed() {
    let t = tab_with(&[0], &["allowlist"]);
    let muxed = MuxedAddress::generate(&t.e);
    let policy = PayeeAllowlistPolicyClient::new(&t.e, &t.allowlist);
    policy.add_payee(&t.rule, &muxed.address(), &t.account);

    assert_eq!(
        authorise(&t, transfer(&t, muxed.to_val(), 1_000), t.rule, Some(&AGENT_SK)),
        refused_with(PayeeAllowlistError::NotAllowed as u32)
    );
    // The unmuxed account itself is payable.
    assert_eq!(authorise(&t, transfer(&t, muxed.address().to_val(), 1_000), t.rule, Some(&AGENT_SK)), Ok(()));
}

#[test]
fn with_no_authenticated_signer_the_allowlist_alone_refuses() {
    /*
     * A rule with policies skips the account's "every signer matched" check
     * and defers to the policies. With the allowlist as the ONLY policy, an
     * unsigned transfer to a listed payee must still be refused, by us.
     */
    let t = tab_with(&[0], &["allowlist"]);

    assert_eq!(
        authorise(&t, transfer(&t, t.payee.to_val(), 1_000), t.rule, None),
        refused_with(PayeeAllowlistError::NotAllowed as u32)
    );
}

#[test]
fn removing_the_rule_uninstalls_the_list() {
    let t = tab();
    let policy = PayeeAllowlistPolicyClient::new(&t.e, &t.allowlist);

    BarkeepSmartAccountClient::new(&t.e, &t.account).remove_context_rule(&t.rule);

    assert_eq!(
        policy.try_get_payees(&t.rule, &t.account),
        Err(Ok(Error::from_contract_error(PayeeAllowlistError::SmartAccountNotInstalled as u32)))
    );
}
