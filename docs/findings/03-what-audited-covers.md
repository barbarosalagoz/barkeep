> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# "Audited" covered none of what I deploy

**Status:** confirmed from the upstream repository and the crate, 2026-09-12.
Nothing to report upstream; the correction was to my own docs.

## What I expected

I built the tab on OpenZeppelin's `stellar-accounts` because I did not want to
write custody logic. OpenZeppelin publishes audit reports for that repository.
So my architecture plan said the funds "sit in an audited OpenZeppelin smart
account", the intro said the cap was "enforced on-chain by an OpenZeppelin
smart account", and three crate manifests called `stellar-accounts` "the
audited crate". I had transferred someone else's audit to my deployment
without noticing I had done it.

## What I observed

Two separate errors, compounded.

The first: `stellar-accounts` 0.7.2 is a library, not a set of deployable
contracts. It has no `#[contract]` anywhere outside its own tests. The
verifiers are plain functions in `verifiers::ed25519` and
`verifiers::webauthn`. `SmartAccount` and `Policy` are traits with default
bodies. A smart account reaches a verifier or a policy by address, so every
contract that goes on chain has to be written by the person deploying it. I
found this when I went to deploy the verifiers (commit db87031) and there was
nothing to deploy. All five contracts in `deployments/testnet.json` are
therefore mine: two verifiers, the account, the spending-limit policy and the
payee allowlist.

The second: the audits do not cover the release I use. The repository holds
seven reports, 0.1.0-RC through 0.7.0, all first-party. The most recent covers
commit `239a2a7`, tagged `v0.7.0-rc.1`. The published 0.7.2 I pin is four tags
past it: rc.2, 0.7.0, 0.7.1, 0.7.2. No crates.io release corresponds exactly
to audited code, so "pin the audited version" was not an option available to
me. What changed between `239a2a7` and 0.7.2 is not recorded in this repo. What
I did record, when I built the `4529d70` crates, is that `spending_limit`
changed again after 0.7.2 (zero-amount transfers now always pass), which is
the kind of change a four-tag gap can hold.

So what the audits are evidence about is the cryptographic and storage
building blocks my contracts call into, at a nearby commit. They say nothing
about my verifier contracts, my account contract, my policies, how I wire them
together, or the four-tag delta in the library itself.

I reversed the claim in commit 243961c: a new §4.1 in
`docs/ARCHITECTURE-v2.md` with a table of every deployed contract and its
audit status, all "No"; `"audited": false` on every contract in
`deployments/testnet.json`; `docs/DEPLOYMENTS.md` leading with the position;
the manifests and the policy crate's header corrected. Since then every new
contract has carried the same line at the top of its `lib.rs`.

## How I measured it

Not a transaction. The record is documentary.

- The absence of `#[contract]` outside tests in `stellar-accounts` 0.7.2:
  stated in commit db87031 and `docs/ARCHITECTURE-v2.md` §4. The repo does not
  record the grep, but the consequence is checkable: `contracts/barkeep-*`
  exist because there was nothing else to deploy.
- The audit reports and the commit each covers: stated in
  `docs/ARCHITECTURE-v2.md` §4.1 as seven reports and `239a2a7` for the
  latest. The repo does not record the URL or the command used to read the
  report's commit, so a reader should open OpenZeppelin/stellar-contracts'
  audits directory and check `239a2a7` against the `v0.7.0-rc.1` tag before
  quoting the number. The "four tags" count is the tag list between
  `v0.7.0-rc.1` and `v0.7.2`.
- What is deployed: `deployments/testnet.json`, `contracts`, one entry per
  contract with its crate path, wasm hash and `"audited": false`.

The wasm hash next to each id is how to confirm that the contract at that
address is the code in this repo: rebuild and compare.

## What it means for other builders

Wording that is accurate, from §4.1:

> Barkeep's smart account is built on OpenZeppelin's `stellar-accounts`
> library, which OpenZeppelin has audited in-house at v0.7.0-rc.1. Barkeep's
> own contracts, the verifiers, the account and the policies, are unaudited,
> run on Testnet only, and an external review is budgeted before any mainnet
> use.

Wording that is not, and that I had written:

> Funds sit in an audited OpenZeppelin smart account.

If you build on `stellar-accounts`, you deploy your own contracts, and their
audit status is yours to state. The library's audit is a fact about the
functions you call, at a commit you are probably not on. Say which commit, say
it is first-party, and say what of yours it does not cover.

A related trap for anyone pinning by git: the `v0.9.0` branch at `4529d70`
still reports version 0.7.1 in its crate metadata, so a version string on its
own does not tell you what code you have.

## Where it has been reported

There is nothing to report. The library's README does not claim its users'
contracts are audited; I did. One thing I could ask upstream for is a
crates.io release that matches an audited commit exactly, or a note in each
report saying which published version, if any, it corresponds to. I have not
asked.

## Record

- Commit `243961c`, "docs: stop implying our deployed contracts are audited": the reversal, with every corrected sentence listed.
- `docs/ARCHITECTURE-v2.md` §4 (library, not contracts), §4.1 (the table and the quotable wording), §9 (the `stellar-accounts` row), §10 risks 2 and 3.
- Commit `db87031`: the discovery that there was nothing to deploy.
- `deployments/testnet.json`, `$comment` and the `audited` flags.
- `docs/DEPLOYMENTS.md`, first paragraph.
- `contracts/barkeep-smart-account/src/lib.rs`, `contracts/barkeep-policy/src/lib.rs`, `contracts/barkeep-payee-allowlist/src/lib.rs`: the header line each carries.
- Commit `5eae2a4`: the 0.7.1 version field on the `4529d70` pin, and the `spending_limit` change after 0.7.2.
