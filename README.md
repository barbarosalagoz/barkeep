# Barkeep

**Open a tab for your AI agent.**

Barkeep is a Stellar dApp for machine payments. A human opens a tab with a
spending cap and a time window. An agent spends against it to pay for HTTP
requests. Every payment lands on an itemised bill.

Home: **[barkeep.dev](https://barkeep.dev)**

> **What ships today.** The MCP server in `packages/mcp-server`, on Stellar
> Testnet. It opens a tab, pays for HTTP requests against it, reports the bill
> and closes it. See [The tab (MCP server)](#the-tab-mcp-server-testnet),
> including what it **cannot** pay yet. The cap and the payee list are
> enforced on chain by policy contracts on an OpenZeppelin smart account. The
> bill dashboard and plugin packaging are still a plan. The design is in
> [docs/ARCHITECTURE-v2.md](docs/ARCHITECTURE-v2.md).
>
> The project was previously named **PromptRail**. Its Stellar Journey to
> Mastery (Yellow Belt) submission record is preserved under the old name in
> [docs/YELLOW_BELT.md](docs/YELLOW_BELT.md): the Payment Tracker escrow
> contract, the multi-wallet dApp and the deployment the submission links to.

---

## The tab (MCP server, Testnet)

`packages/mcp-server` is a local stdio MCP server for Claude Code. A tab is an
on-chain context rule on a smart account built on OpenZeppelin's
`stellar-accounts` library. The rule has the agent's session key as its only
signer, a spending-limit policy, a payee-allowlist policy, and an expiry. The
cap and the list of payees are enforced by those policies on chain, not by
the server. None of these contracts is audited. The allowlist is Barkeep's
own, since `stellar-accounts` ships none. See
[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

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
| `close_tab` | Removes the rule, revoking the session key |

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
│   ├── barkeep-v09-*/               # the same set on stellar-accounts 4529d70 (#868)
│   ├── barkeep-auth-probe/
│   └── payment-tracker/             # Yellow Belt escrow contract: frozen, see docs/YELLOW_BELT.md
│
├── packages/
│   ├── core/                        # @barkeep/core: SDK-free primitives (errors, network)
│   ├── tab-read/                    # @barkeep/tab-read: read a tab from the chain; shared by the server and the bill
│   ├── mcp-server/                  # @barkeep/mcp: open_tab, pay_and_fetch, tab_status, close_tab
│   │   ├── bin/barkeep-mcp          #   wrapper Claude Code launches; reads keys from the Stellar CLI store
│   │   ├── src/                     #   the tools, the x402 client scheme, the facilitator, the seller
│   │   └── scripts/                 #   the Testnet done-tests (hashes in deployments/testnet.json)
│   └── web/                         # @barkeep/web: the PromptRail dApp (Yellow Belt) and the SEP ramp
│       └── build/                   #   the third-party licence gate
│
├── deployments/
│   ├── testnet.json                 # contract ids, wasm hashes, and every done-test's tx hashes
│   └── testnet-v09.json
│
├── docs/
│   ├── README.md                    # index of the docs below
│   ├── HOW_IT_WORKS.md              # one payment walked through, file by file
│   ├── findings/                    # six things found while building, with their evidence
│   ├── ARCHITECTURE-v2.md           # the design; §4.1 is the audit position
│   ├── DEPLOYMENTS.md               # keys, identities, how to redeploy
│   ├── YELLOW_BELT.md               # the PromptRail submission record, preserved
│   ├── SUBMISSION_PACK.md
│   ├── SEP_RAMP.md
│   └── screenshots/
│
├── scripts/                         # verifier checks, passkey registration and signing pages
├── package.json                     # npm workspaces: packages/*
└── README.md
```

---

## Future Vision

With the Payment Tracker contract live on Testnet, Barkeep now has both
halves of a machine-payment system: an on-chain settlement layer and a wallet
frontend that drives it.

Future versions may introduce:

* Paid API endpoints
* Stablecoin payments
* Usage-based API billing
* AI agent payments
* Machine-to-machine payment flows
* Developer SDKs
* Payment analytics
* Mainnet support

The long-term idea is simple:

> Make digital services directly purchasable by software.

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
