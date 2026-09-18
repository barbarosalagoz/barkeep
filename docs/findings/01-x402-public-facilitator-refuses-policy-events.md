# The public x402 facilitator refuses the accounts that enforce a cap on chain

**Status:** confirmed on Testnet, 2026-09-13. The event check was reported
upstream before I hit it, by someone else, as x402#3352 (2026-09-03). My
comment there and a separate fee-ceiling issue are drafted, not yet posted.

## What I expected

I chose x402 for one reason above every other. The client signs an
authorisation entry, not the transaction. The facilitator throws away the
envelope, rebuilds it with its own source account, pays the fee and submits.
That is why a contract account can pay at all. `docs/ARCHITECTURE-v2.md` §3.1
called it "the single most important reason to choose x402 on Stellar for this
product". I had written that sentence myself and I believed it. The first time
I actually sent a smart-account payment to `https://x402.org/facilitator` was
the spike below. Until then I expected it to go through like any other.

## What I observed

The public facilitator refused every payment from the tab. Two checks in
`@x402/stellar` 2.25.0 refuse it, independently of each other. I only saw the
second after I had got past the first.

The first is the fee ceiling. The facilitator simulates the payment and
refuses any transaction whose resource fee is above 50,000 stroops. A transfer
from the smart account simulated at 324,039 stroops. That is what it costs:
`__check_auth` calls the ed25519 verifier contract, and the spending-limit
policy reads and rewrites its window history. A classic account's transfer in
the same harness was charged 23,039.

The second is the event check. `validateSimulationEvents` refuses any contract
event whose first topic is not `transfer`, from any contract. The spending-limit
policy emits `spending_limit_enforced` from inside `__check_auth` on every
capped spend. So the event that proves the cap was enforced is the event that
gets the payment refused.

I relaxed both checks in a facilitator I run myself. The same payload settled
on chain.

My reading of this is that the accounts that enforce their own limits are the
accounts the stock facilitator will not take. That is my interpretation. What
the record shows is narrower. A `spending_limit` account is refused for those
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

T0 is the control. It proves the seller and the facilitator pipeline work. So
a later refusal belongs to the smart account and not to my harness. T1 is a
separate finding. The stock client hands the SDK raw signature bytes.
`authorizeEntry` treats those as a classic-account signature, so the stock
client cannot sign for a C-address at all. T2's client-side simulation
recorded the two events, `spending_limit_enforced` from the policy
`CBEILTNY…` and `transfer` from the token, one auth entry and a minimum
resource fee of 323,939.

The tab for the run was rule 11. I opened it in
`cd771493521a85e1472fedc0d058fd5a13fc4eed3d913503ec1233028723ec91` and closed
it in `6a4b722c5e835ea0925d8bdcc371d95b7e3d6ed2dd23c569d0feaa4e919522d8` with
0.0001 TAB spent, which is T4's payment. I cross-checked successful flags,
ledgers and fees on Horizon. I read T4's auth entry and events back from RPC.

What the record does not establish: which version of `@x402/stellar` the
public facilitator was running on 2026-09-13. T2's refusal string matches the
2.25.0 source. T3 reproduced the next refusal with 2.25.0 locally. So I treat
the public deployment as running that code with its defaults. That is likely,
not measured.

## What it means for other builders

If your payer is a smart account whose `__check_auth` emits any event, a
facilitator on stock `@x402/stellar` refuses you. If your `__check_auth` calls
another contract, the fee ceiling refuses you first.

Two consequences shaped Barkeep. The payee-allowlist policy
(`contracts/barkeep-payee-allowlist`) emits nothing from `enforce`, so it adds
no second reason to refuse. A refused payee reverts the transaction anyway,
and the `transfer` event already names the payee that passed. And
`pay_and_fetch` pays only sellers whose facilitator accepts a smart-account
payer. Today that means one running `packages/mcp-server/src/facilitator.ts`.
That file is upstream 2.25.0 with exactly two changes, each commented with the
check it relaxes. `maxTransactionFeeStroops` is raised to 1,000,000 through
the constructor option. `validateSimulationEvents` runs only over events
emitted by the asset contract. It still requires exactly one `transfer` from
the asset with the expected from, to and amount. The README and the tool
description both say plainly that this is the limit of what the tool can pay.

Everything else about x402 on Stellar held. The facilitator did pass the smart
account's auth entry through untouched. The payer spent no sequence number and
paid no fee.

## Where it has been reported

I wrote "Nowhere yet" here on 2026-09-13. That was true of me and wrong about
the problem. When I went to file it on 2026-09-18 the event check was already
in the x402 foundation's monorepo: x402#3352, opened by someone else on
2026-09-03, ten days before my run, with the same `spending_limit_enforced`
case. x402#3399 (2026-09-08) proposes the fix, scoping the check to the asset
contract, which is the narrowing `facilitator.ts` runs.

So I am not opening a second issue for it. My measurements go on #3352 as a
comment: T3 and T4, the same payload refused by the stock check and settling
with the check scoped to the asset, in support of #3399's approach. The draft
is `docs/upstream/x402-3352-comment.md`. Not yet posted.

The fee ceiling is not in #3352 and is checked first, so it would keep
refusing this payer after #3399 merges. That goes in a separate issue. The draft is
`docs/upstream/x402-fee-ceiling-default.md`: the 50,000-stroop default against
the 324,039 measured here, the fact that `maxTransactionFeeStroops` is a
constructor option a hosted facilitator's callers cannot reach, and a proposal
to raise the default or publish the ceiling in `/supported`. Not yet posted.

T1, the stock client's inability to sign for a C-address, was also already
reported, as x402#3158 (2026-08-14).

## Record

- `deployments/testnet.json`, `doneTests.x402Spike`: every hash, ledger, fee, refusal string and event above.
- `packages/mcp-server/scripts/x402-spike-testnet.mjs`: the script, as it ran.
- Commit `27ab3d6` (in PR #3): the run written up at the time.
- `packages/mcp-server/src/facilitator.ts`: the two relaxations, with the upstream checks named.
- `docs/ARCHITECTURE-v2.md` §3.1: the original expectation and the dated correction.
- `docs/upstream/x402-3352-comment.md` and `docs/upstream/x402-fee-ceiling-default.md`: the two upstream drafts.
- PR #6 body and `contracts/barkeep-payee-allowlist/src/lib.rs`, "Events": why the allowlist emits nothing.
