> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# The public x402 facilitator refuses the accounts that enforce a cap on chain

**Status:** confirmed on Testnet, 2026-09-13. Not reported upstream.

## What I expected

I chose x402 for one reason above every other: the client signs an
authorisation entry, not the transaction. The facilitator throws away the
envelope, rebuilds it with its own source account, pays the fee and submits.
That is why a contract account can pay at all. `docs/ARCHITECTURE-v2.md` §3.1
called it "the single most important reason to choose x402 on Stellar for this
product", and I expected a payment from the tab to go through
`https://x402.org/facilitator` like any other.

## What I observed

The public facilitator refused every payment from the tab. Two checks in
`@x402/stellar` 2.25.0 refuse it independently, and I only saw the second after
I had got past the first.

The first is the fee ceiling. The facilitator simulates the payment and
refuses any transaction whose resource fee is above 50,000 stroops. A transfer
from the smart account simulated at 324,039 stroops: `__check_auth` calls the
ed25519 verifier contract and the spending-limit policy reads and rewrites its
window history. A classic account's transfer in the same harness was charged
23,039.

The second is the event check. `validateSimulationEvents` refuses any contract
event whose first topic is not `transfer`, from any contract. The spending-limit
policy emits `spending_limit_enforced` from inside `__check_auth` on every
capped spend. So the event that proves the cap was enforced is the event that
gets the payment refused.

With both checks relaxed in a facilitator I run myself, the same payload
settled on chain.

I read this as: the accounts that enforce their own limits are the accounts
the stock facilitator will not take. That sentence is my interpretation. What
the record shows is narrower: a `spending_limit` account is refused for those
two reasons, by that version of the facilitator code, with its defaults.

## How I measured it

The script is `packages/mcp-server/scripts/x402-spike-testnet.mjs`, committed
as it ran (27ab3d6). It stands up a local x402 v2 seller on 127.0.0.1 and runs
five cases. The record is `deployments/testnet.json`, `doneTests.x402Spike`.

```sh
cd packages/mcp-server
BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
npx tsx scripts/x402-spike-testnet.mjs
```

| Case | Payer, client, facilitator | Result |
| --- | --- | --- |
| T0 | G-account, stock `@x402/stellar` client, public facilitator | Settled. `8cdcd81b9e30905fe175f8d1d827906031893cadc1964a2c11881be428a108e6`, ledger 4649840, fee charged 23,039 |
| T1 | Smart account, stock client | Threw before any request: `invalid version byte. expected 48, got 16` |
| T2 | Smart account, my `signAs` client, public facilitator | Refused: `invalid_exact_stellar_payload_fee_exceeds_maximum`, "simulation-derived fee 324039 stroops exceeds ceiling 50000 stroops" |
| T3 | Same payload, `@x402/stellar` 2.25.0 run locally with only the ceiling raised to 2,000,000 | Refused: `invalid_exact_stellar_payload_event_not_transfer` |
| T4 | Same, ceiling raised and events filtered to the asset contract | Settled. `c02f9035c0eb0250a619633c192aca4e43996a89dad927f7236f7508aab64aaf`, ledger 4649844, fee charged 276,476 |

T0 is the control. It proves the seller and the facilitator pipeline work, so
a later refusal belongs to the smart account and not to my harness. T1 is a
separate finding: the stock client hands the SDK raw signature bytes, which
`authorizeEntry` treats as a classic-account signature, so it cannot sign for
a C-address at all. T2's client-side simulation recorded the two events,
`spending_limit_enforced` from the policy `CBEILTNY…` and `transfer` from the
token, one auth entry and a minimum resource fee of 323,939.

The tab for the run was rule 11, opened in
`cd771493521a85e1472fedc0d058fd5a13fc4eed3d913503ec1233028723ec91` and closed
in `6a4b722c5e835ea0925d8bdcc371d95b7e3d6ed2dd23c569d0feaa4e919522d8` with
0.0001 TAB spent, which is T4's payment. Successful flags, ledgers and fees
were cross-checked on Horizon; T4's auth entry and events were read back from
RPC.

What the record does not establish: which version of `@x402/stellar` the
public facilitator was running on 2026-09-13. T2's refusal string matches the
2.25.0 source, and T3 reproduced the next refusal with 2.25.0 locally, so I
treat the public deployment as running that code with its defaults. That is
likely, not measured.

## What it means for other builders

If your payer is a smart account whose `__check_auth` emits any event, a
facilitator on stock `@x402/stellar` refuses you. If your `__check_auth` calls
another contract, the fee ceiling refuses you first.

Two consequences shaped Barkeep. The payee-allowlist policy
(`contracts/barkeep-payee-allowlist`) emits nothing from `enforce`, so it adds
no second reason to refuse; a refused payee reverts the transaction anyway and
the `transfer` event already names the payee that passed. And `pay_and_fetch`
pays only sellers whose facilitator accepts a smart-account payer, which today
means one running `packages/mcp-server/src/facilitator.ts`. That file is
upstream 2.25.0 with exactly two changes, each commented with the check it
relaxes: `maxTransactionFeeStroops` raised to 1,000,000 through the
constructor option, and `validateSimulationEvents` run only over events
emitted by the asset contract. It still requires exactly one `transfer` from
the asset with the expected from, to and amount. The README and the tool
description both say plainly that this is the limit of what the tool can pay.

Everything else about x402 on Stellar held. The facilitator did pass the smart
account's auth entry through untouched. The payer spent no sequence number and
paid no fee.

## Where it has been reported

Nowhere yet. There is no draft in the repo for this one.

It belongs in the x402 foundation's monorepo against `@x402/stellar`, as two
points: the event check should be scoped to the asset contract rather than to
every contract in the simulation, and the public deployment's 50,000-stroop
default is below what a `__check_auth` that calls a verifier contract cost
here.
T1, the stock client's inability to sign for a C-address, is a third point and
may belong with the SDK's `AssembledTransaction.signAuthEntries` instead.

## Record

- `deployments/testnet.json`, `doneTests.x402Spike`: every hash, ledger, fee, refusal string and event above.
- `packages/mcp-server/scripts/x402-spike-testnet.mjs`: the script, as it ran.
- Commit `27ab3d6` (in PR #3): the run written up at the time.
- `packages/mcp-server/src/facilitator.ts`: the two relaxations, with the upstream checks named.
- `docs/ARCHITECTURE-v2.md` §3.1: the original expectation and the dated correction.
- PR #6 body and `contracts/barkeep-payee-allowlist/src/lib.rs`, "Events": why the allowlist emits nothing.
