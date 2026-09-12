# DRAFT — not posted. Run 2026-09-12; results filled in.

Intended for `OpenZeppelin/stellar-contracts`, as an issue. Nothing here has
been sent upstream.

Every case below was run against Testnet and every value is observed, not
expected. The raw record is `deployments/testnet-v09.json` (`doneTests`,
`clientFlow`); the scripts are
`packages/mcp-server/scripts/v09-client-flow-testnet.mjs` and
`v09-tab-lifecycle-testnet.mjs`. No case was skipped, so no row is `TBD`.

Before posting:

1. Re-check the `v0.9.0` branch head (it was `c008f2d` when this ran). If 0.9.0
   has published, say whether it contains `4529d70` and whether you re-ran
   against the published crate.
2. Review the scripts, the transactions and this text personally, including
   opening the transaction links. The body below says that review happened; it
   must be true when posted.
3. Decide whether to keep the Barkeep-specific done-test paragraph. It is
   evidence that the flow works under a real policy, but it is our product, not
   their library.
4. Delete this header.

---

**Title:** Testnet confirmation of the v0.9.0 smart-account client flow (External and Delegated signers)

**Body:**

> **AI-assisted.** The scripts behind this report and the first draft of this
> text were written with an AI coding assistant (Claude). I have reviewed the
> scripts, checked every transaction below on a block explorer, and edited this
> text myself before posting. Your contributing guide asks for that scrutiny,
> so I would rather say it plainly than leave you to guess.

#868 (fixing #876) moved signers to `AuthDigestPreimage` and added
`test/auth_entries.rs`, which builds both signers' authorization entries and
drives them through `__check_auth`. Those tests run in an in-memory `Env` with
`set_auths`. What they cannot exercise is RPC simulation, which is where #839
and #863 went wrong: simulation does not return the `Delegated` signer's entry,
and a client that trusts it submits a transaction that looks complete and
traps.

So I ran the flow the new "Authorizing from a Client" section describes against
a real deployment, from a TypeScript client. **It works as documented.** Every
case below behaved the way the README says it should, including the
cross-account replay #876 describes, which succeeds against 0.7.2 accounts and
is refused by 4529d70 ones. A few observations that are not in the README are at
the end. Nothing here proposes a code change.

### Setup

- `stellar-accounts` from branch `v0.9.0` at
  `4529d708c47866bec790223b88036f9aa9e404b3` (the #868 merge), pinned as a git
  dependency. Unpublished at the time; the crate's version field still reads
  `0.7.1`.
- `soroban-sdk` **27.0.6**, not the 27.0.2 in your lockfile at that commit: our
  workspace already resolves 27.0.6 and Cargo keeps one version per compatible
  range. Built with `stellar contract build` (stellar-cli 28.0.0).
- Testnet, protocol 28. Client-flow cases in ledgers 4644335–4644359.
- `@stellar/stellar-sdk` 16.3.0. `simulateTransaction(tx)` with no `authMode`
  argument, i.e. the RPC default. Recording-mode results are read from the raw
  response (`_simulateTransaction`), not the SDK's summary.
- Contracts, mirroring `auth_entries.rs`:
  - smart account (`SmartAccount` + `CustomAccountInterface` delegating to
    `do_check_auth`): [`CBBUT7…L6OO`](https://stellar.expert/explorer/testnet/contract/CBBUT7CC36RBR4IKEAI6BOX64AJEZ7DYHE3E4WYFC3VBZQ2TDJGLL6OO)
  - probe with `ping(caller) { caller.require_auth() }` and a no-argument
    `ping_owner()` (see the replay section): [`CC36Q5…PJ5E`](https://stellar.expert/explorer/testnet/contract/CC36Q5YIYFFWTWXZDWEV4AD2GDLZKAFEUZFXOXFH2YCDA4UTOEPGPJ5E)
  - ed25519 verifier wrapping `verifiers::ed25519`: [`CD3353…NNS2`](https://stellar.expert/explorer/testnet/contract/CD3353QQM4TUCYGNE3U3SDDMM7GTR4IN4C4DKVZV5C6ETXYEFYMFNNS2)
  - rule 1: `CallContract(probe)` with an `External` ed25519 key; rule 2:
    `CallContract(probe)` with a `Delegated` G-account
- Client-side preimage: `ScVal::Map` with keys `account`, `context_rule_ids`,
  `signature_payload`, SHA-256 over its XDR

Each refused case was also **submitted**, not only simulated. A failed
simulation returns no footprint, so the transaction borrowed one from a
correctly signed copy with the same nonces and expiration (simulated, never
sent). The ledger keys are the same, and the errors below come from the
ledger's own diagnostic events, not from simulation.

### External signer

| # | Case | Simulation with signed entries | On chain |
| --- | --- | --- | --- |
| E1 | Client digest vs `auth_digest(preimage)` view, simulated | Equal: `d4bf07e4…c87e` both ways, for `signature_payload` `ca438a0e…3967`, rule `[1]` | — |
| E2 | Sign `sha256(preimage.to_xdr())` | ok | [Success](https://stellar.expert/explorer/testnet/tx/97b9e4feafecdae4828f7de66b1a25646815334fe0160d1c8b01a7f269215dd5), ledger 4644344 |
| E3 | Sign the raw `signature_payload` | `Error(Auth, InvalidAction)`, `Error(Crypto, InvalidInput)` | [Failed](https://stellar.expert/explorer/testnet/tx/1bbff72b6a390a354af38298a84ca67d42bf5e19f973cb24edd9d242bcbfa210), ledger 4644345: `failed ED25519 verification` → `Error(Crypto, InvalidInput)` → `Error(Auth, InvalidAction)` |
| E4 | Sign the 0.7.x digest, `sha256(signature_payload ‖ context_rule_ids.to_xdr())` | Same as E3 | [Failed](https://stellar.expert/explorer/testnet/tx/53de1f45f4061da865a3b856757649a10180c60e3ca5a8b0b15f3684ba911022), ledger 4644347, same errors as E3 |

E4 is the case a client that missed the migration will hit.

For E1, the same preimage with its keys in declaration order (`account`,
`signature_payload`, `context_rule_ids`) is refused before the view runs:
`HostError: Error(Object, InvalidInput)`, "ScMap was not sorted by key for
conversion to host object". So the sorted order is the only one the host
accepts, and the view is a good way to find that out.

### Delegated signer

| # | Case | Simulation with signed entries | On chain |
| --- | --- | --- | --- |
| D0 | Recording-mode simulation of `probe.ping(account)`: entries in raw `auth[]` | **One**, for the smart account `CBBUT7…L6OO`; none for the delegate | — |
| D1 | Account entry + hand-added root entry for the delegate, invocation `__check_auth` on the account, argument the preimage map, signed ed25519 | ok | [Success](https://stellar.expert/explorer/testnet/tx/992999c433894f6c14e729e7a36c13811d9df1a70d97a28bb86650ac8042d07d), ledger 4644348 |
| D2 | Account entry only | `Error(Auth, InvalidAction)` | [Failed](https://stellar.expert/explorer/testnet/tx/178c9a2cbfcd555c98ed18e086e92df8cdc3f04a12b0095c63e0018a6b21708f), ledger 4644349: "Unauthorized function call for address" `GDUQ…D5TS` from `require_auth_for_args`, trapped in `__check_auth` → `Error(Auth, InvalidAction)` |
| D3 | Delegate entry whose argument is the 32-byte digest, not the map | `Error(Auth, InvalidAction)` | [Failed](https://stellar.expert/explorer/testnet/tx/6a27377cf168ee79204b112ac2460110e0c9d94980e54d6a0a14db7e6aff939a), ledger 4644350: identical diagnostic sequence to D2 |

In our 0.7.2 work, recording-mode simulation never ran `__check_auth`, so a
rejection showed up only on a *second* simulation with the signed entries
attached. That holds here too, and the second simulation caught **every**
refusal (E3, E4, D2, D3) before submission. A client that re-simulates with
its signed entries does not need to reach the ledger to find out.

### Account binding (#876)

The binding is only observable with an invocation that does not name the
account; `probe.ping(account)` already differs per account. So the probe also
stores an owner address, and `ping_owner()` calls `owner.require_auth()` with no
arguments. Two accounts list the same `External` key under a
`CallContract(probe)` rule with the same rule id (1). Sign for account A and
submit; point the probe at B; submit A's entry for B with only the address
changed. I compared the two transactions' envelopes: the signature `ScVal`, the
nonce, the expiration ledger and the invocation are byte-identical, and the
client computed the same `signature_payload` for both.

| # | Accounts built from | Signed for A | A's entry replayed against B |
| --- | --- | --- | --- |
| R1 | `stellar-accounts` 0.7.2 | [Success](https://stellar.expert/explorer/testnet/tx/8bbc4be9185ed1e83bd406e7f920d860a05ff17d75fff9e666d574b718717675), ledger 4644353 | **[Accepted](https://stellar.expert/explorer/testnet/tx/512dbcbfa209f5fe92d36542500417c1ec9d23d9ad87cbfb375941c7a25b2be4)**, ledger 4644355, same nonce `8746352541701827608`. The gap #876 describes |
| R2 | `4529d70` | [Success](https://stellar.expert/explorer/testnet/tx/0cee10936f8445f763d7d8a9196f6c5c63b59ed956f433bef452a2bb27aa5cf2), ledger 4644357 | **[Refused](https://stellar.expert/explorer/testnet/tx/dbeb6f62c96e00fb684be29ca6d5ea6e01993ef8ca4e9e15210987be427f0cdf)**, ledger 4644359: `Error(Crypto, InvalidInput)` → `Error(Auth, InvalidAction)`. Also refused at simulation |

R1 also confirms the premise: nonces are tracked per authorizing address, so
the nonce A had just consumed was unused for B.

Separately, on our own product account built on 4529d70 with a real
`spending_limit` policy, the three lifecycle proofs held unchanged: under cap
[succeeds](https://stellar.expert/explorer/testnet/tx/f785643d32ca6439b346b508cfc1442b0a7be84f10936cac9056092cce6e266c),
over cap [fails `#3221`](https://stellar.expert/explorer/testnet/tx/2095fbb1355e37d38995d38f443b65b222e7225c54846f1c12053e5b921f691c),
after `valid_until` [fails `#3002`](https://stellar.expert/explorer/testnet/tx/4dc98c2f130d4b8b8b6d748199ae544caedd7e0a2372ca809bf06b1dd012aff0).

### Result

Confirmed as documented. External signers verify against
`sha256(preimage.to_xdr())` and nothing else. The `auth_digest` view agrees with
an independent TypeScript encoding. Simulation does not return the delegated
signer's entry, and the manual second root entry the README describes works.
A signature collected for one 4529d70 account is refused by another that lists
the same key, while the same replay goes through on 0.7.2.

Observations the README does not currently state, none of them a bug:

1. **External signer failures never surface as `ExternalVerificationFailed`
   (3003) with the shipped ed25519 verifier.** `verifiers::ed25519::verify`
   calls the host's `ed25519_verify`, which traps instead of returning `false`
   (its doc says so), so `authenticate`'s `!verify(..)` branch is not reached.
   A wrong digest, a wrong key and a cross-account replay all read as
   `Error(Crypto, InvalidInput)` then `Error(Auth, InvalidAction)`. The
   "Authorizing from a Client" section describes the delegated failure mode
   but not this one.
2. **D2 (entry missing) and D3 (entry with the wrong argument) are
   indistinguishable on chain.** Both are "Unauthorized function call for
   address" from `require_auth_for_args`. The README says as much for
   "missing or wrongly encoded"; noting that the diagnostic text does not
   separate them either.
3. Neither delegated failure showed the `Error(WasmVm, InvalidAction)` /
   `UnreachableCodeReached` trace quoted in #839. The trap here is a
   `HostError` escalated from `require_auth_for_args`, so #839's trace may have
   had a different immediate cause. I have not reproduced #839's construction.

### Questions

1. Would the client script be useful to you, and where? It is TypeScript, so
   possibly not in this repository. Options I can see: a gist linked from the
   docs' "Transaction Simulation Behavior" section, or nowhere. Happy with
   either.
2. Minor, noticed while reading: the migration guide #868 adds is headed
   "from v0.7.x to 0.8.0", but the change is on the `v0.9.0` branch and not in
   `v0.8.0-rc.3`. If 0.8.0 is not going to carry it, the heading may mislead.
