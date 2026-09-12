use soroban_sdk::{testutils::Address as _, Address, Env};

use crate::{AuthProbe, AuthProbeClient};

#[test]
fn ping_owner_demands_auth_from_the_stored_owner() {
    let e = Env::default();
    let client = AuthProbeClient::new(&e, &e.register(AuthProbe, ()));
    let owner = Address::generate(&e);

    client.set_owner(&owner);
    assert_eq!(client.owner(), Some(owner.clone()));

    assert!(client.try_ping_owner().is_err(), "no auth supplied, must fail");

    e.mock_all_auths();
    client.ping_owner();
    assert_eq!(e.auths()[0].0, owner);
}

#[test]
fn ping_demands_auth_from_the_caller_argument() {
    let e = Env::default();
    let client = AuthProbeClient::new(&e, &e.register(AuthProbe, ()));
    let caller = Address::generate(&e);

    assert!(client.try_ping(&caller).is_err());

    e.mock_all_auths();
    client.ping(&caller);
    assert_eq!(e.auths()[0].0, caller);
}
