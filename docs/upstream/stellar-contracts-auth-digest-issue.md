# DRAFT — not posted

Intended for `OpenZeppelin/stellar-contracts`, as an issue before any PR.
Review and edit before opening it. Nothing here has been sent upstream.

---

**Title:** Client-side helper for the smart account `auth_digest`

**Body:**

`stellar-accounts` 0.7.2 requires a client to reproduce one value exactly before
it can authorise anything on a smart account:

```
auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
```

Signers must sign that, not the `signature_payload` the host provides. This is
documented on `AuthPayload` in `smart_account/storage.rs`, but as far as I can
find the repository ships no client-side implementation of it, in TypeScript or
otherwise. Every integrator writes it again from the doc comment.

### Why this one is worth shipping rather than leaving to integrators

Most reimplementation is merely tedious. This one fails quietly.

The digest exists to bind the rule selection into what was signed. If a client
signs the raw `signature_payload` instead — the obvious mistake, since that is
what `__check_auth` receives and what every non-custom account signs — the
resulting signature is cryptographically valid over a payload that says nothing
about which context rule was chosen. The account-level check is what makes rule
selection unforgeable, so a client that skips the digest produces signatures
whose rule binding is absent rather than wrong. The failure mode is a signature
gathered under a narrow, policy-bearing rule being presentable against a wider
one.

A client author has no easy way to notice. The signature verifies. The
transaction succeeds. Nothing surfaces until someone selects a different rule
than the signer intended.

The encoding has two more places to get it wrong, both silent:

- `context_rule_ids.to_xdr()` is the **ScVal** encoding of `Vec<u32>`, including
  the `SCV_VEC` and `SCV_U32` discriminants — not a bare XDR array. An empty
  vector is `000000100000000100000000`, not four zero bytes.
- `AuthPayload` is a `#[contracttype]` struct, so its map keys must be in sorted
  order (`context_rule_ids` before `signers`), as must the `signers` map itself.

### What I would contribute

I have a working TypeScript implementation, currently in my own repository. I am
happy to clean it up and open a PR if you want it, or to close this if you do
not.

Two pure functions, which are the part I would argue for:

- `authDigest(signaturePayload: Uint8Array, contextRuleIds: number[]): Uint8Array`
- `contextRuleIdsToXdr(contextRuleIds: number[]): Uint8Array`

The `AuthPayload` assembly I would leave out of a first PR. It hardcodes field
names and the `Delegated` / `External` tags, so it is the piece most likely to
drift from the contract; it would be better generated from the contract spec.

What I think is actually valuable here is the test vectors. Mine are emitted by
the contract itself — a Soroban `Env` running `Vec<u32>::to_xdr` and
`env.crypto().sha256()` — and the TypeScript asserts against them, so the two
implementations check each other rather than one checking itself:

| `signature_payload` | `context_rule_ids` | `auth_digest` |
| --- | --- | --- |
| 32 zero bytes | `[0]` | `cd8f38f416e883abd1c3fa555bfbe29f70a28c1ec9c1ebab27e0b055829a33ac` |
| `00 01 02 … 1f` | `[1]` | `93d0d91205b61ce9d2d7e8d03b7f03d85a9420a09a087390367ca07baabf42a0` |
| `00 01 02 … 1f` | `[1, 2]` | `38adbae1abad527443bb95a44f1dc45f4d7da7d235f40f00a010891a1c5589e2` |
| `00 01 02 … 1f` | `[]` | `28e8deb1fe446e87d7169b4ffe821d196a40486aa5a8b8e95798c6d76c82fdaf` |

And for the vector encoding itself:

| `Vec<u32>` | `to_xdr()` |
| --- | --- |
| `[]` | `000000100000000100000000` |
| `[1, 2]` | `00000010000000010000000200000003000000010000000300000002` |

Those are useful whether or not you take any code: an integrator writing their
own client can check against them.

### The question

Do you want a JavaScript/TypeScript helper in this repository at all?

It is a Rust contracts repo, and adding a JS surface means a build, a test
runner and a publishing story that do not exist here today. The alternatives are
a separate bindings package, or keeping the repo Rust-only and instead
publishing the vectors plus a worked example in the `AuthPayload` docs — which
would address most of the hazard above at a fraction of the maintenance.

I do not have a view on which is right for you. Happy to do whichever, or
neither.

### Checked against

`stellar-accounts` 0.7.2, `soroban-sdk` 26.1.0, protocol 28 on Testnet.
