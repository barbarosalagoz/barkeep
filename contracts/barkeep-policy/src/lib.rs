#![no_std]

//! Barkeep policy contracts for OpenZeppelin smart accounts.
//!
//! Placeholder. The deliverable here is `payee_allowlist`, the policy that caps
//! *who* the tab can pay: `stellar-accounts` 0.7.2 ships only
//! `simple_threshold`, `weighted_threshold` and `spending_limit`, so the
//! allowlist has to be written by us, and is unaudited like every other
//! contract this repo deploys (`docs/ARCHITECTURE-v2.md` §4.1)
//! (`docs/ARCHITECTURE-v2.md` §4, §10 risk 1, Week 2 in §12).
//!
//! This crate exists now to carry the version pin: it builds against the
//! `soroban-sdk` 26.1.0 that the `stellar-accounts` library requires,
//! while `payment-tracker` stays on the workspace's 27.0.6.

use soroban_sdk::{contract, contractimpl, Env};

#[contract]
pub struct PayeeAllowlist;

#[contractimpl]
impl PayeeAllowlist {
    /// Placeholder entry point; replaced by the real policy interface in Week 2.
    pub fn ledger(env: Env) -> u32 {
        env.ledger().sequence()
    }
}
