#![no_std]

//! A test target for smart-account authorisation, never part of the product.
//!
//! Two ways to demand auth from an address:
//!
//! - `ping(caller)` names the caller in its arguments, so the authorised
//!   invocation -- and therefore the host's `signature_payload` -- differs per
//!   caller. This mirrors `Probe` in stellar-accounts' `test/auth_entries.rs`.
//! - `ping_owner()` takes no arguments and demands auth from an address held in
//!   storage. The invocation is then identical whichever account is the owner,
//!   which is the only way to observe whether a signature is bound to the
//!   account (OpenZeppelin/stellar-contracts#876): with `ping(caller)` the
//!   payload already differs, and a replay fails for that reason instead.
//!
//! `set_owner` is deliberately unauthenticated. Anyone may point the probe at
//! any address; the point is what that address's `__check_auth` then accepts.
//! Nothing of value is held here.

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env, Symbol};

const OWNER: Symbol = symbol_short!("OWNER");

#[contract]
pub struct AuthProbe;

#[contractimpl]
impl AuthProbe {
    pub fn ping(_e: &Env, caller: Address) {
        caller.require_auth();
    }

    pub fn set_owner(e: &Env, owner: Address) {
        e.storage().instance().set(&OWNER, &owner);
    }

    pub fn owner(e: &Env) -> Option<Address> {
        e.storage().instance().get(&OWNER)
    }

    pub fn ping_owner(e: &Env) {
        let owner: Address = e.storage().instance().get(&OWNER).expect("owner not set");
        owner.require_auth();
    }
}

#[cfg(test)]
mod test;
