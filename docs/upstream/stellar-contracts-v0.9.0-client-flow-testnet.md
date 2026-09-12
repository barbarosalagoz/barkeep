# DRAFT — not posted, not run

Intended for `OpenZeppelin/stellar-contracts`, as an issue. Nothing here has
been sent upstream, and **none of the cases below has been run yet.** Every
`TBD` is a result we do not have. Do not post a single expected value as if it
were observed.

Before posting:

1. Run every case against a real Testnet deployment and fill in each `TBD`
   with the observed result and a transaction hash, or with the simulation
   output where no transaction exists.
2. Delete any case that was not run, rather than leaving it `TBD`.
3. Re-check the `v0.9.0` branch head; if 0.9.0 has published, test the
   published crate instead and say so.
4. Review the scripts, the transactions and this text personally. The body
   below says that review happened; it must be true when posted.
5. Delete this header.

---

**Title:** Testnet confirmation of the v0.9.0 smart-account client flow (External and Delegated signers)

**Body:**

> **AI-assisted.** The scripts behind this report and the first draft of this
> text were written with an AI coding assistant (Claude). I have reviewed the
> scripts, checked every transaction hash below on a block explorer, and edited
> this text myself before posting. Your contributing guide asks for that
> scrutiny, so I would rather say it plainly than leave you to guess.

#868 (fixing #876) moved signers to `AuthDigestPreimage` and added
`test/auth_entries.rs`, which builds both signers' authorization entries and
drives them through `__check_auth`. Those tests run in an in-memory `Env` with
`set_auths`. What they cannot exercise is RPC simulation, which is where #839
and #863 went wrong: simulation does not return the `Delegated` signer's entry,
and a client that trusts it submits a transaction that looks complete and
traps.

So I ran the flow the new "Authorizing from a Client" section describes against
a real deployment, from a TypeScript client, to confirm it end to end or find
where it differs. Nothing below proposes a code change.

### Setup

- `stellar-accounts` from branch `v0.9.0` at `TBD` (unpublished at the time),
  `soroban-sdk` `TBD`, built with `stellar contract build`
- Testnet, protocol `TBD`, ledgers `TBD`–`TBD`
- `@stellar/stellar-sdk` `TBD`. `simulateTransaction` called as
  `(tx, undefined, authMode)`; `authMode` is the third positional argument, per
  the correction on #863
- Contracts, mirroring `auth_entries.rs`:
  - smart account (`SmartAccount` + `CustomAccountInterface` delegating to
    `do_check_auth`): `TBD`
  - `Probe` with `ping(caller) { caller.require_auth() }`: `TBD`
  - ed25519 verifier (`verifiers::ed25519`): `TBD`
  - one `CallContract(probe)` rule per signer kind: an `External` ed25519 key,
    and a `Delegated` G-account
- Client-side preimage: `ScVal::Map` with keys `account`, `context_rule_ids`,
  `signature_payload`, hashed with SHA-256 over its XDR

### External signer

| # | Case | Expected per README | Simulation with signed entries | On chain |
| --- | --- | --- | --- | --- |
| E1 | Client digest vs `auth_digest(preimage)` view, simulated | Equal | `TBD` | — |
| E2 | Sign `sha256(preimage.to_xdr())` | Success | `TBD` | `TBD` |
| E3 | Sign the raw `signature_payload` | Rejected | `TBD` | `TBD` |
| E4 | Sign the 0.7.x digest, `sha256(signature_payload ‖ context_rule_ids.to_xdr())` | Rejected | `TBD` | `TBD` |

E4 is the case a client that missed the migration will hit.

### Delegated signer

| # | Case | Expected per README | Simulation with signed entries | On chain |
| --- | --- | --- | --- | --- |
| D0 | Recording-mode simulation of `probe.ping(account)`: entries in raw `auth[]` | One, the account's only | `TBD` (raw count) | — |
| D1 | Account entry + hand-added root entry for the delegate, invocation `__check_auth` on the account, argument the preimage map, signed ed25519 | Success | `TBD` | `TBD` |
| D2 | Account entry only | `Error(Auth, InvalidAction)`, trap in `__check_auth` | `TBD` | `TBD` |
| D3 | Delegate entry whose argument is the 32-byte digest, not the map | Rejected | `TBD` | `TBD` |

One thing worth recording whichever way it lands: in our 0.7.2 work,
recording-mode simulation never ran `__check_auth`, so a rejection showed up
only on a *second* simulation with the signed entries attached. The
"simulation with signed entries" column is there to show whether D2 and D3 can
be caught before submission or only on chain.

### Account binding (#876)

The binding is only observable with an invocation that does not name the
account; `probe.ping(account)` already differs per account. So a second probe
stores an owner address and `ping()` calls `owner.require_auth()`, with no
arguments. Two accounts list the same `External` key under a
`CallContract(probe)` rule with the same rule id. Sign for account A, set the
owner to B, submit the same signature in an entry for B with the same nonce
and expiration. Nonces are tracked per authorizing address, so B's should be
unused; R1 is what confirms it.

| # | Accounts built from | Expected | On chain |
| --- | --- | --- | --- |
| R1 | `stellar-accounts` 0.7.2 | Accepted — the gap #876 describes | `TBD` |
| R2 | `v0.9.0` | Rejected | `TBD` |

### Result

`TBD` — one paragraph: confirmed as documented, or exactly where it differed.

### Questions

1. Would the client script be useful to you, and where? It is TypeScript, so
   possibly not in this repository. Options I can see: a gist linked from the
   docs' "Transaction Simulation Behavior" section, or nowhere. Happy with
   either.
2. Minor, noticed while reading: the migration guide #868 adds is headed
   "from v0.7.x to 0.8.0", but the change is on the `v0.9.0` branch and not in
   `v0.8.0-rc.3`. If 0.8.0 is not going to carry it, the heading may mislead.
