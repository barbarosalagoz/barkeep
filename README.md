# Barkeep

**A spending-capped, payee-limited agent account on Stellar.**

A human opens a *tab* for an AI agent: a cap, a list of who the agent may pay,
and an expiry. The agent pays for HTTP requests (x402) against it. The cap and
the payee list are enforced on chain by policy contracts on an OpenZeppelin
smart account, not by the agent or its server. Every payment lands on an
itemised bill.

Repository: **[github.com/barbarosalagoz/barkeep](https://github.com/barbarosalagoz/barkeep)**

> **Status, read first.**
>
> - **Stellar Testnet only.** Nothing here runs on Stellar mainnet.
> - **Unaudited.** None of Barkeep's contracts is audited; see
>   [ARCHITECTURE-v2.md §4.1](docs/ARCHITECTURE-v2.md#41-what-is-audited-and-what-is-not)
>   before repeating any audit claim.
> - **No external users yet.** Every transaction in this repository's records
>   was made by the author, with keys the author holds. Usage by anyone else is recorded
>   separately, in [docs/EXTERNAL_USAGE.md](docs/EXTERNAL_USAGE.md), and that
>   table is empty today.
> - **Pays only sellers whose x402 facilitator accepts a smart-account payer.**
>   The public facilitator does not yet; see
>   [Who `pay_and_fetch` can pay](#who-pay_and_fetch-can-pay-read-this-first).
> - **Built with an AI coding assistant.** What that covers and how quality is
>   enforced: [docs/AI_ASSISTED_DEVELOPMENT.md](docs/AI_ASSISTED_DEVELOPMENT.md).
>   How keys are handled: [docs/KEY_MANAGEMENT.md](docs/KEY_MANAGEMENT.md).
>
> What ships today is the MCP server in `packages/mcp-server`. The bill
> dashboard and plugin packaging are still a plan; the design is in
> [docs/ARCHITECTURE-v2.md](docs/ARCHITECTURE-v2.md).

---

## The tab (MCP server, Testnet)

`packages/mcp-server` is a local stdio MCP server for Claude Code. A tab is an
on-chain context rule on a smart account built on OpenZeppelin's
`stellar-accounts` library. The rule has a session key made for that tab as its only
signer, a spending-limit policy, a payee-allowlist policy, and an expiry. The
cap and the list of payees are enforced by those policies on chain, not by
the server. None of these contracts is audited. The allowlist is Barkeep's
own, since `stellar-accounts` ships none. See
[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

**One key per tab.** `open_tab` makes a fresh agent key for each tab, and
`close_tab` destroys it once the rule is gone, so a leaked key reaches one tab.
This is covered by offline tests (`src/agentKeys.test.ts`). Its Testnet
done-test has not been run yet. The hashes recorded below were made with the
earlier shared agent key. See [docs/KEY_MANAGEMENT.md](docs/KEY_MANAGEMENT.md).

**Payees fail closed.** `open_tab` takes `payees`, and a transfer to anyone
else is refused on chain (`Error(Contract, #3901)`). A tab with no list must
be opened with `allow_any_payee: true`, said explicitly. With neither,
`open_tab` refuses. The flag is shown by `tab_status` and on every receipt.
The agent's key cannot change the list. The human signer can, with
`add_payee` / `remove_payee` on the policy. Paying a payee not known when the
tab was opened is not supported.

| Tool | What it does |
| --- | --- |
| `open_tab` | Adds the agent rule with a cap, a window, and who it may pay |
| `pay_and_fetch` | Fetches a URL; on an x402 402 challenge, pays it from the tab |
| `tab_status` | Limit, spent, remaining and payees, read from the chain, plus receipts |
| `close_tab` | Removes the rule, revoking the session key, then destroys that key |

### Who `pay_and_fetch` can pay (read this first)

**It pays sellers whose x402 facilitator accepts a smart-account payer. It
does not pay arbitrary x402 endpoints today.**

An x402 seller hands payment verification to a facilitator. The public one,
`https://x402.org/facilitator`, refuses every payment from a Barkeep tab. I
measured two reasons on Testnet (`deployments/testnet.json`,
`doneTests.x402Spike`):

1. **Its event check.** Upstream `@x402/stellar` rejects any contract event
   that is not a `transfer`. The spending-limit policy emits
   `spending_limit_enforced` on every capped spend. So the thing that makes a
   tab a tab is what gets refused. The payee allowlist deliberately emits
   nothing when it passes a payment, so it adds no second event to refuse.
   Barkeep's facilitator would tolerate one. A third-party one would not.
2. **Its fee ceiling.** 50,000 stroops by default. A smart-account transfer
   simulated at 324,039.

A seller like that answers the paid request with a refusal and nothing is
paid. `packages/mcp-server/src/facilitator.ts` is the same upstream
facilitator with exactly those two checks relaxed. Each relaxation is
commented with the upstream check it relaxes. A seller that points at it can
be paid. Until upstream accepts smart-account payers, that is the reach of
this tool.

Per call, `max_amount` caps the price. Identical calls (same tab, URL,
`max_amount` and optional `request_id`) pay once. Both are enforced by the
server. The tab's cap is enforced on chain. The money tools carry the
`anthropic/requiresUserInteraction` flag, so the host asks on every call.
Every payment appends a receipt to the state directory's `receipts.jsonl`: tx
hash, amount, endpoint, timestamp, tab id, `allow_any_payee`.

### Run the demo stack

Three processes. Keys are read from the Stellar CLI key store, never from a
file in the repo or from Claude Code's configuration.

```sh
# 1. the facilitator: pays settlement fees with its OWN key. It refuses to
#    start on the deployer key that open_tab and close_tab submit with.
BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-facilitator) \
  npx tsx packages/mcp-server/src/facilitator.ts        # http://127.0.0.1:4020

# 2. a seller to pay: persistent account, adds its TAB trustline on first start,
#    refuses to start if the facilitator is not answering.
BARKEEP_SELLER_SECRET=$(stellar keys secret barkeep-testnet-seller) \
  npx tsx packages/mcp-server/src/seller.ts             # http://127.0.0.1:4021
#    /haiku 0.0001   /forecast 0.00025   /dataset 0.002 (above a small tab)

# 3. the MCP server in Claude Code, through a wrapper that reads the keys at
#    launch; the registration stores only the wrapper's path.
claude mcp add barkeep --scope local -- "$PWD/packages/mcp-server/bin/barkeep-mcp"
```

Then, in Claude Code: open a tab (`PT1H` or longer, so it outlives the take)
with the seller as its payee, `GASFR7KGGFZR5ODT37BRCHSGK3UP4ULDUV4QU7IAN42ABVCTC53H77H7`,
and ask for `http://127.0.0.1:4021/haiku`. Repeating an identical call returns
the first result without paying again. Pass a new `request_id` to pay again.

Checks, from `packages/mcp-server`:

```sh
# the stack above, end to end through the wrapper (services 1 and 2 running)
npx tsx scripts/demo-stack-testnet.mjs

# the pay_and_fetch done-tests: pay, over-cap refusal, idempotency
BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-facilitator) \
npx tsx scripts/pay-and-fetch-testnet.mjs

# the payee-allowlist done-tests (same four keys): allowlisted payee pays,
# unlisted payee and over-cap both fail on chain, the agent cannot add a payee,
# a tab with no payees and no allow_any_payee is refused
npx tsx scripts/payee-allowlist-testnet.mjs
```

Results, with transaction hashes, are recorded under `doneTests.payAndFetch`,
`doneTests.demoStack` and `doneTests.payeeAllowlist` in
`deployments/testnet.json`.

## How it works

A tab is a context rule on a smart account. The agent's key is its only
signer. A spending limit and a payee allowlist are its policies. An expiry
ledger ends it. The agent signs a `transfer` on the token under that rule. A
facilitator that accepts smart-account payers submits it. A receipt lands on
the bill. [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) walks one payment
through and names the file for each step. It also describes the three traps
that cost me a debugging round each: recording-mode simulation, `transfer`
versus `execute`, and the delegated signer's missing entry.

## What I found building this

Six things I did not expect, each with the hashes or commands behind it and
where it has or has not been reported. Index in
[docs/README.md](docs/README.md).

1. [The public x402 facilitator refuses accounts that enforce a cap on chain](docs/findings/01-x402-public-facilitator-refuses-policy-events.md)
2. [A `stellar-accounts` 0.7.2 signature verifies on another account that lists the same key](docs/findings/02-auth-digest-not-account-scoped.md)
3. ["Audited" covered none of what I deploy](docs/findings/03-what-audited-covers.md)
4. [The ed25519 verifier never returns false, so every signing mistake looks the same](docs/findings/04-ed25519-verifier-panics-not-false.md)
5. [Four places the TR Mock Anchor differs from its own documentation](docs/findings/05-tr-mock-anchor-deviations.md)
6. [The WebAuthn verifier passed its done-test and could never be called by the account](docs/findings/06-webauthn-verifier-sig-data-not-xdr.md)

---


## Evidence and records

| What | Where | Who generated it |
| --- | --- | --- |
| Contract ids, wasm hashes, every done-test's tx hashes and refusal codes | [deployments/testnet.json](deployments/testnet.json) | The author, on Testnet |
| Test suites | `cargo test --workspace`, `npm run test:unit`; both run in [CI](.github/workflows/ci.yml) on every PR | — |
| Usage by anyone other than the author | [docs/EXTERNAL_USAGE.md](docs/EXTERNAL_USAGE.md) (empty today) | Third parties, with consent |
| Findings reported upstream | [docs/README.md](docs/README.md#upstream) | The author |
| How AI was used | [docs/AI_ASSISTED_DEVELOPMENT.md](docs/AI_ASSISTED_DEVELOPMENT.md) | — |
| Keys: generation, storage, rotation, destruction | [docs/KEY_MANAGEMENT.md](docs/KEY_MANAGEMENT.md) | — |

The two kinds of record are never mixed: the author's runs stay in
`deployments/*.json`, and a row goes into the external usage table only when
the person who made the transaction generated their own key and consented to
its listing.

---

## Project Structure

```text
barkeep/
│
├── Cargo.toml                       # Soroban workspace: every crate under contracts/
├── contracts/
│   ├── barkeep-smart-account/       # the tab: OpenZeppelin stellar-accounts 0.7.2 account
│   ├── barkeep-policy/              # spending_limit policy (the library's, wrapped)
│   ├── barkeep-payee-allowlist/     # payee allowlist policy (ours; unaudited)
│   ├── barkeep-verifier-ed25519/    # signature verifiers the account calls
│   ├── barkeep-verifier-webauthn/
│   ├── barkeep-auth-probe/
│   ├── barkeep-v09-*/               # history: the same set on stellar-accounts 4529d70 (#868)
│   └── payment-tracker/             # history: Yellow Belt escrow contract, frozen
│
├── packages/
│   ├── core/                        # @barkeep/core: SDK-free primitives (errors, network)
│   ├── tab-read/                    # @barkeep/tab-read: read a tab from the chain; shared by the server and the bill
│   ├── mcp-server/                  # @barkeep/mcp: open_tab, pay_and_fetch, tab_status, close_tab
│   │   ├── bin/barkeep-mcp          #   wrapper Claude Code launches; reads keys from the Stellar CLI store
│   │   ├── src/                     #   the tools, the x402 client scheme, the facilitator, the seller
│   │   └── scripts/                 #   the Testnet done-tests (hashes in deployments/testnet.json)
│   └── web/                         # history: the PromptRail dApp (Yellow Belt) and the SEP ramp
│       └── build/                   #   the third-party licence gate
│
├── deployments/
│   ├── testnet.json                 # contract ids, wasm hashes, and every done-test's tx hashes
│   └── testnet-v09.json             # history: the 4529d70 twin deployment
│
├── docs/
│   ├── README.md                    # index of the docs below
│   ├── HOW_IT_WORKS.md              # one payment walked through, file by file
│   ├── findings/                    # six things found while building, with their evidence
│   ├── ARCHITECTURE-v2.md           # the design; §4.1 is the audit position
│   ├── DEPLOYMENTS.md               # identities, how to redeploy
│   ├── KEY_MANAGEMENT.md            # key lifecycle, Testnet and the Arc mainnet run
│   ├── AI_ASSISTED_DEVELOPMENT.md   # what was written with Claude Code, and how it is checked
│   ├── EXTERNAL_USAGE.md            # third-party usage, kept apart from the author's runs
│   ├── INSTAWARD_*.md               # SCF Instaward application, working notes, open items
│   ├── Barkeep_Instaward_Application.pdf  # clean copy of the application
│   └── YELLOW_BELT.md, SUBMISSION_PACK.md, SEP_RAMP.md, screenshots/   # history
│
├── scripts/                         # verifier checks, passkey registration and signing pages
├── package.json                     # npm workspaces: packages/*
└── README.md
```

---

## History

Barkeep grew out of earlier work in this repository. None of it is part of
the product above; it is kept because it was submitted or measured under
these names and the records should stay verifiable.

- **PromptRail (Stellar Journey to Mastery, Rise In).** The project was
  previously named PromptRail. Its White and Yellow Belt work (a multi-wallet
  Testnet dApp and the Payment Tracker escrow contract) is preserved under the
  old name in [docs/YELLOW_BELT.md](docs/YELLOW_BELT.md), with the paste-ready
  submission text in [docs/SUBMISSION_PACK.md](docs/SUBMISSION_PACK.md). That
  dApp is still deployed at
  [promptrail-ten.vercel.app](https://promptrail-ten.vercel.app/) (Testnet). It
  is the belt-era app, not the tab.
- **The TRY on/off-ramp (SEP-1, 10, 38, 6).** An integration against the Rise
  In TR Mock Anchor, in `packages/web`: [docs/SEP_RAMP.md](docs/SEP_RAMP.md).
  Finding 05 comes from it.
- **The v0.9 twin deployment.** The same contracts built on the unpublished
  `stellar-accounts` v0.9.0 branch (`4529d70`) and deployed next to 0.7.2, to
  confirm the account-scoped auth digest and the client flow before migrating:
  `contracts/barkeep-v09-*`, [deployments/testnet-v09.json](deployments/testnet-v09.json),
  [docs/MIGRATION-stellar-accounts-0.9.0.md](docs/MIGRATION-stellar-accounts-0.9.0.md),
  reported as [OpenZeppelin/stellar-contracts#897](https://github.com/OpenZeppelin/stellar-contracts/issues/897).
  The product stays on 0.7.2 until 0.9.0 is published.
- **Barkeep on Arc.** The same design rebuilt on Circle's Arc, including a
  small mainnet run: [barbarosalagoz/barkeep-arc](https://github.com/barbarosalagoz/barkeep-arc).
  A separate repository and a different chain; nothing in it is evidence about
  Stellar.

---

## License

The Barkeep source code in this repository is licensed under the
[Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

Copyright 2026 Barbaros Emre Alagöz

Revisions up to and including commit `49a2b12` were released under the MIT
License.

Third-party dependencies, including the packages bundled into the web build,
remain under their own licenses. Each build ships their license texts and
copyright notices at `/third-party-licenses.txt`, generated during
`npm run build` by [rollup-plugin-license](https://github.com/mjeanroy/rollup-plugin-license)
(MIT). The build fails if a bundled package is unlicensed or uses a license
outside the permissive allow-list in `build/third-party-licenses.ts`.
