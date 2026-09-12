# Migration: `stellar-accounts` 0.7.2 → 0.9.0

**Status:** not started, deliberately. We stay on `=0.7.2` until 0.9.0 is
published to crates.io. This file records what will break so the migration does
not have to rediscover it. Checked 2026-09-12.

## Why

Under 0.7.2 the digest signers sign is

```
auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
```

and `signature_payload` names no account, so a signature also verifies on any
other smart account listing the same signer (ARCHITECTURE-v2 §10, risk 13).
Upstream issue [OpenZeppelin/stellar-contracts#876](https://github.com/OpenZeppelin/stellar-contracts/issues/876);
fixed by [#868](https://github.com/OpenZeppelin/stellar-contracts/pull/868),
merged 2026-09-10 as `4529d70` into the `v0.9.0` branch.

Where the fix is, as of 2026-09-12:

| Ref | Contains `4529d70`? |
| --- | --- |
| crates.io `stellar-accounts` (latest 0.7.2) | No |
| tag `v0.8.0-rc.3` (latest 0.8 pre-release) | No |
| `main` | No |
| branch `v0.9.0` | Yes |

The migration guide #868 adds to `packages/accounts/README.md` is headed
"from v0.7.x to 0.8.0", but the change landed only on the `v0.9.0` branch. Go by
whichever *published* release actually contains `4529d70`, not by the heading.

## The new preimage

```rust
#[contracttype]
pub struct AuthDigestPreimage {
    pub account: Address,              // the smart account (current_contract_address)
    pub signature_payload: BytesN<32>, // from the host, unchanged
    pub context_rule_ids: Vec<u32>,    // one per auth context, unchanged
}
```

- **External signers** (our agent session key and the ed25519 admin signer) sign
  `sha256(preimage.to_xdr())`.
- **Delegated signers** authorize the struct itself:
  `require_auth_for_args((preimage,))`. Simulation still does not return that
  entry; the client adds a second root-level entry for the delegated address
  whose root invocation is `__check_auth` on the smart account with the
  preimage as its single argument. We use no `Delegated` signers today.
- New view `auth_digest(preimage) -> BytesN<32>` returns the same digest.
  Simulate it to check the client-side encoding against the deployed contract.

As an ScVal, `#[contracttype]` makes it a map keyed by field name with the keys
sorted, so the order is `account`, `context_rule_ids`, `signature_payload` —
not the declaration order:

```ts
const preimage = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("account"),
                       val: new Address(smartAccount).toScVal() }),
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"),
                       val: xdr.ScVal.scvVec(ruleIds.map((id) => xdr.ScVal.scvU32(id))) }),
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("signature_payload"),
                       val: xdr.ScVal.scvBytes(Buffer.from(signaturePayload)) }),
]);
const digest = hash(preimage.toXDR()); // what an External signer signs
```

This is a sketch written from #868's README and its `auth_digest_matches_off_chain_encoding`
test, not code that has run. The reference client construction is
`packages/accounts/src/smart_account/test/auth_entries.rs` on the `v0.9.0` branch.

## What breaks

**`packages/mcp-server/src/authDigest.ts`.** `authDigest(signaturePayload,
contextRuleIds)` computes the 0.7.2 concatenation, which 0.9.0 rejects.
It needs the account address as a third input and to hash the map above.
`contextRuleIdsToXdr` becomes an internal detail of the preimage rather than a
hashed input of its own. `buildAuthPayload` and `signerToScVal` do not change:
#868 leaves `AuthPayload` and `Signer` as they were. The file header's
reference to "ARCHITECTURE-v2 §14 q5" is already stale (§14 has four
questions); fix it while rewriting.

**`packages/mcp-server/src/authDigest.test.ts`.** Every `authDigest` vector is a
0.7.2 digest. Regenerate them from `AuthDigestPreimage::digest` in a real `Env`
and include the account address in each vector, then confirm one against the
deployed `auth_digest` view by simulation.

**The four `=0.7.2` crates:**

| Crate | What changes |
| --- | --- |
| `contracts/barkeep-smart-account` | Pin, and `AuthDigestPreimage` must be imported beside `AuthPayload` etc., because `#[contractimpl(contracttrait)]` re-emits the trait signatures, which now include `auth_digest`. The `__check_auth` doc comment quotes the old formula. `src/test.rs` pins and prints the old digest: rewrite `digest_hex` and `print_auth_digest_vectors` |
| `contracts/barkeep-policy` | Pin. #868 does not touch policies; re-diff the branch at publish |
| `contracts/barkeep-verifier-ed25519` | Pin. The `Verifier` trait is not in #868; re-diff at publish. The verifier only sees 32 bytes, so its logic is unaffected by the digest change |
| `contracts/barkeep-verifier-webauthn` | Same as ed25519 |

All four also pin `soroban-sdk = "=26.1.0"` because 0.7.2 requires it. The
`v0.9.0` branch is on `soroban-sdk` 27.0.2, with a bump to Protocol 28 open as
[#866](https://github.com/OpenZeppelin/stellar-contracts/pull/866). Take the
SDK pin from the published 0.9.0 manifest; the split from the workspace's
27.0.6 (ARCHITECTURE-v2 §3.3) may close.

**Redeployment.** `BarkeepSmartAccount` does not implement `Upgradeable`, so
there is no in-place upgrade: the migrated account is a new contract at a new
address. Rules, signers and policy state on
`CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH` do not carry over.
Close live tabs first; update `deployments/testnet.json` and
`docs/DEPLOYMENTS.md`. The verifier and policy contracts are separate and do
not see the digest change; redeploy them only if the published 0.9.0 changes
their code.

**`packages/mcp-server/scripts/tab-lifecycle-testnet.mjs`.** Imports `authDigest`
directly and calls `authDigest(payload, [ruleId])` in its signer callback.
Needs the account address. Its recorded done-test hashes in
`deployments/testnet.json` are 0.7.2 evidence and need re-running, not editing.

**The MCP tools.** `open_tab` and `close_tab` sign with the admin key through
`src/chain.ts` `signAs`, which calls `authDigest(payload, [contextRuleId])`;
`cfg.smartAccount` is already in scope there, so the fix is to pass it. The
same path is what `scripts/tab-tools-testnet.mjs` exercises, including the
transfer made outside the server. `tab_status` only reads and is unaffected.
`pay_and_fetch` is a stub, but whatever implements it signs through `signAs`
too. Re-run both Testnet scripts against the new deployment; the offline
`server.test.ts` does not sign and will not catch a wrong digest.

## Retired

`docs/upstream/stellar-contracts-auth-digest-issue.md` was deleted: it proposed
a client helper for the 0.7.2 concatenation, which #868 replaced with a
`#[contracttype]` preimage and an `auth_digest` view in the contract spec.
