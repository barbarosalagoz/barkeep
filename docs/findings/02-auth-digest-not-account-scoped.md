> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# A 0.7.2 smart-account signature verifies on another account that lists the same key

**Status:** confirmed on Testnet, 2026-09-12, against two throwaway accounts per
library version. Upstream already knew: OpenZeppelin/stellar-contracts#876,
fixed by #868 on the unpublished `v0.9.0` branch. My contribution is the
Testnet confirmation, written up in
`docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md`, which is a
filled-in draft and has not been posted.

## What I expected

I expected the digest a signer signs to be bound to the account it is signing
for. Under `stellar-accounts` 0.7.2 it is

```
auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
```

and I had written the client side of that in
`packages/mcp-server/src/authDigest.ts`, checked byte-for-byte against vectors
the contract itself emits. The rule ids are in the digest, so a signature
collected for the capped agent rule cannot be replayed to select the
unrestricted admin rule. I took that as the whole replay story.

## What I observed

The account is not in the digest. `signature_payload` is the host's hash over
the invocation, nonce, expiration and network, and it names no authorizer
address. So a signature for account A also verifies on account B, provided B
lists the same signer under the same rule id and the invocation, nonce and
expiration are the same.

On 0.7.2 the replay was accepted. On commit `4529d70` of the `v0.9.0` branch,
where #868 moved signers to an `AuthDigestPreimage` that includes the account
address, the same replay was refused.

The gap was not exploitable in Barkeep as deployed, for two reasons that are
worth keeping apart. One is circumstance: Testnet, one smart account, every key
mine. The other is a side effect of my call shapes: every invocation the tab
signs names the account, as the contract for `add_context_rule` and
`remove_context_rule` and as `from` for `transfer`, so the payload already
differs per account. That is not something the 0.7.2 contract guarantees, and
I did not want to lean on it.

I got one thing wrong on the way. My first upstream draft,
`docs/upstream/stellar-contracts-auth-digest-issue.md`, proposed a client
helper for the 0.7.2 concatenation. #868 replaced the concatenation with a
`#[contracttype]` preimage and an `auth_digest` view in the contract spec, so
the draft was arguing for the wrong thing and I deleted it (commit 3fd9bc0).
A second correction followed the same evening: 3fd9bc0 claimed `authDigest.ts`
cited a section that did not exist, because I had read
`docs/ARCHITECTURE-v2.md` only to line 540. The citation was right; the claim
was withdrawn in 5ebf471.

## How I measured it

The binding is only observable with an invocation that does not name the
account, since `transfer(from, …)` already differs per account. So the probe
contract `contracts/barkeep-auth-probe` stores an owner and exposes
`ping_owner()`, which calls `owner.require_auth()` with no arguments. Two
accounts list the same external ed25519 key under rule id 1. Sign for A and
submit; point the probe at B; submit A's entry against B with only the address
changed.

The script is `packages/mcp-server/scripts/v09-client-flow-testnet.mjs`; the
record is `deployments/testnet-v09.json`, `clientFlow.R1` and `clientFlow.R2`.

```sh
cd packages/mcp-server
ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
npx tsx scripts/v09-client-flow-testnet.mjs
```

| Case | Accounts built on | Signed for A | A's entry replayed against B |
| --- | --- | --- | --- |
| R1 | `stellar-accounts` 0.7.2 (`CBTLXOWP…`, `CD6YEXFH…`, deployed from the wasm hash already in `testnet.json`) | `8bbc4be9185ed1e83bd406e7f920d860a05ff17d75fff9e666d574b718717675`, ledger 4644353 | Accepted: `512dbcbfa209f5fe92d36542500417c1ec9d23d9ad87cbfb375941c7a25b2be4`, ledger 4644355, same nonce `8746352541701827608` |
| R2 | `4529d70` (`CBBUT7CC…`, `CDGEXSWI…`) | `0cee10936f8445f763d7d8a9196f6c5c63b59ed956f433bef452a2bb27aa5cf2`, ledger 4644357 | Refused: `dbeb6f62c96e00fb684be29ca6d5ea6e01993ef8ca4e9e15210987be427f0cdf`, ledger 4644359, `Error(Crypto, InvalidInput)` then `Error(Auth, InvalidAction)` |

I compared the two envelopes in each pair: the signature ScVal, nonce,
expiration ledger and invocation are byte-identical, and the client computed
the same `signature_payload` for both accounts. R1 also confirms the premise
that nonces are tracked per authorizing address, so the nonce A had consumed
was still unused for B.

Two throwaway 0.7.2 accounts were used for R1 so the recorded product account
in `deployments/testnet.json` was never touched. The `4529d70` build is a git
pin; the crate's version field still reads 0.7.1 because upstream had not
bumped it. Ledgers and successful flags were cross-checked on Horizon; the
refusal in R2 comes from the ledger's diagnostic events, not from simulation.

## What it means for other builders

If you deploy a `stellar-accounts` 0.7.2 account and a signer of yours is also
listed on someone else's 0.7.2 account under the same rule id, a signature you
give one can be presented to the other. The invocation, nonce and expiration
must match, so an invocation that names your account is safe by accident.
`transfer` does. `ping_owner()`-shaped calls do not.

The fix is on the `v0.9.0` branch only. As of 2026-09-12 it was not in
crates.io 0.7.2, not in tag `v0.8.0-rc.3` and not on `main`, even though the
migration guide #868 adds is headed "from v0.7.x to 0.8.0". Go by whichever
published release contains `4529d70`.

Barkeep stays on `=0.7.2` until 0.9.0 publishes. The migration cost is written
down in `docs/MIGRATION-stellar-accounts-0.9.0.md`: `authDigest.ts` gains the
account address and hashes a sorted `ScMap` instead of a concatenation, the
four `=0.7.2` crates re-pin, and the account is not upgradeable, so migrating
means a new address. The client side of the new preimage already exists as
`packages/mcp-server/src/authDigestPreimage.ts` and agreed with the deployed
contract's `auth_digest` view on chain (case E1 in the same record).

## Where it has been reported

Upstream issue #876 predates this work; the repo does not record who filed it.
My Testnet confirmation of the `v0.9.0` client flow, including R1 and R2, is
the draft at `docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md`.
Every value in it is filled in from the run. It is not posted. Its header lists
what to do before posting: re-check the branch head, open every transaction
link personally, decide whether to keep the Barkeep-specific paragraph, and
delete the header.

## Record

- `docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md`: the filled-in draft, with every case.
- `deployments/testnet-v09.json`, `clientFlow.R1`, `clientFlow.R2`, `replay072`: hashes, ledgers, account ids.
- `docs/MIGRATION-stellar-accounts-0.9.0.md`: the formula, where the fix lives, what breaks.
- `docs/ARCHITECTURE-v2.md` §10, risk 13.
- Commits `3fd9bc0` (the risk recorded, the first draft deleted), `5ebf471` (a false claim withdrawn), `5eae2a4` (the `4529d70` crates), `6810712` (the run).
- `packages/mcp-server/src/authDigest.ts` and `authDigestPreimage.ts`: the 0.7.2 and `4529d70` client encodings.
