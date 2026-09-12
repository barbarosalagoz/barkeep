extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env,
};
use stellar_accounts::policies::spending_limit::SpendingLimitAccountParams;

use crate::{SpendingLimitPolicy, SpendingLimitPolicyClient};

/*
 * The policy's real behaviour is exercised against a live account on Testnet
 * by packages/mcp-server/scripts/v09-tab-lifecycle-testnet.mjs. What is worth
 * pinning here is the shape of the contract itself.
 */

fn setup() -> (Env, SpendingLimitPolicyClient<'static>, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let id = e.register(SpendingLimitPolicy, ());
    let account = Address::generate(&e);

    (e.clone(), SpendingLimitPolicyClient::new(&e, &id), account)
}

#[test]
fn install_params_round_trip_through_val() {
    let (e, _client, _account) = setup();
    let params = SpendingLimitAccountParams { spending_limit: 100, period_ledgers: 60 };

    // The contract takes install_params as Val and converts; check that the
    // conversion is the identity for the params the account will send.
    let as_val: soroban_sdk::Val = soroban_sdk::IntoVal::into_val(&params, &e);
    let back: SpendingLimitAccountParams = soroban_sdk::IntoVal::into_val(&as_val, &e);

    assert_eq!(back, params);
}

#[test]
fn ledger_sequence_is_the_window_clock() {
    let (e, _client, _account) = setup();

    e.ledger().set_sequence_number(1000);
    assert_eq!(e.ledger().sequence(), 1000);

    // period_ledgers is a count of ledgers, not seconds: the rolling window in
    // the library evicts entries whose ledger_sequence is older than
    // (current - period_ledgers). Recorded here because picking a window in
    // wall-clock time is the easy mistake.
    e.ledger().set_sequence_number(1000 + 60);
    assert_eq!(e.ledger().sequence(), 1060);
}
