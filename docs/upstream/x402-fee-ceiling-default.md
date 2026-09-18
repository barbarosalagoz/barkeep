# DRAFT by Claude for the author's review, not posted. Written 2026-09-18 from docs/findings/01.

Intended for `x402-foundation/x402`, as an issue against `@x402/stellar`.
Nothing here has been sent upstream. Everything below the `---` line is the
issue body; the `gh issue create` command strips this header.

Title: exact/stellar facilitator: the 50,000-stroop maxTransactionFeeStroops default refuses smart-account payers whose __check_auth calls another contract

Record: `deployments/testnet.json` (`doneTests.x402Spike`); script
`packages/mcp-server/scripts/x402-spike-testnet.mjs` (commit 27ab3d6);
`packages/mcp-server/src/facilitator.ts`, relaxation 1.

Read before posting:

- Post the #3352 comment first; this body links to that issue, not to the
  comment.
- Checked 2026-09-18: the three transaction links return 200 from
  `api.stellar.expert`, and Horizon's `successful`, ledger and `fee_charged`
  match the record. `GET https://x402.org/facilitator/supported` returns, for
  Stellar, `extra: {"areFeesSponsored": true}` and nothing about the ceiling.
  On `main` (c8c71f2) the default is still 50,000; #3503 changed the sum from
  `minResourceFee + BASE_FEE` to `minResourceFee + inclusionFeeStroops`.
- No figure for a new default is proposed. The record has one payer's cost, not
  a survey.
- The disclosure says you reviewed this. That has to be true when it is posted.

---

> AI-assisted. The test script and the first draft of this text were written
> with an AI coding assistant (Claude Code). I ran the script myself, checked
> each transaction below on Horizon and a block explorer, and reviewed and
> edited this text before posting.

`https://x402.org/facilitator` refused a valid payment from a Soroban smart
account with `invalid_exact_stellar_payload_fee_exceeds_maximum`. The payload
settles at that fee on a facilitator with a higher ceiling. The payer cannot
learn the ceiling in advance and cannot change it.

### Version

Measured on 2026-09-13 against `@x402/stellar` 2.25.0, Testnet, protocol 28.
Line references are to `scheme.ts` at 626df07, the last change to that file
before 2.25.0 was published. On `main` (c8c71f2) the default is the same and
#3503 replaced `BASE_FEE` in the sum with `inclusionFeeStroops`. I did not
record which version the public facilitator was running that day. Its refusal
string matches the 2.25.0 source, so 2.25.0 with defaults is likely, not
measured.

### The check

`verify` simulates, then compares `minResourceFee + BASE_FEE` with
`maxTransactionFeeStroops`
([L519-L528](https://github.com/x402-foundation/x402/blob/626df07ebc997473d8a35712a610067b0ea12a1f/typescript/packages/mechanisms/stellar/src/exact/facilitator/scheme.ts#L519-L528)).
The default is `DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 50_000` (L36). It is a
constructor option, so whoever runs the facilitator can raise it. A payer or a
seller using a hosted facilitator cannot.

### What a smart account costs

The payer is an OpenZeppelin `stellar-accounts` 0.7.2 smart account. Its
`__check_auth` calls an ed25519 verifier contract and a `spending_limit` policy
that reads and rewrites its window history. One 1000-unit SEP-41 transfer, same
seller and harness for every row:

| Case | Payer | Facilitator | Result |
| --- | --- | --- | --- |
| T0 | G-account | `https://x402.org/facilitator` | Settled: [`8cdcd81b…08e6`](https://stellar.expert/explorer/testnet/tx/8cdcd81b9e30905fe175f8d1d827906031893cadc1964a2c11881be428a108e6), fee charged 23,039 |
| T2 | Smart account | `https://x402.org/facilitator` | Refused: "simulation-derived fee 324039 stroops exceeds ceiling 50000 stroops" |
| T4 | Smart account, same payload | 2.25.0 in process, `maxTransactionFeeStroops` 2,000,000, event check scoped as in #3399 | Settled: [`c02f9035…4aaf`](https://stellar.expert/explorer/testnet/tx/c02f9035c0eb0250a619633c192aca4e43996a89dad927f7236f7508aab64aaf), fee charged 276,476 |

324,039 is `minResourceFee` 323,939 plus 100. That is what this `__check_auth`
costs; nothing in the payload is inflated. T0 is the control. The spending rule
T4 spent under was closed in
[`6a4b722c…22d8`](https://stellar.expert/explorer/testnet/tx/6a4b722c5e835ea0925d8bdcc371d95b7e3d6ed2dd23c569d0feaa4e919522d8)
with exactly T4's payment spent.

This is separate from #3352. The ceiling is checked before
`validateSimulationEvents`, so it keeps refusing this payer after #3399 merges.

### Proposal

Either of these:

1. Raise the default. 50,000 admits a classic account (23,039 here) and
   excludes an account whose `__check_auth` makes one verifier call and one
   policy call. I have one payer's figure, not a survey, so I am not proposing
   a number.
2. Keep the default, document it, and make it discoverable. The README calls
   `maxTransactionFeeStroops` "a safety ceiling" without saying what it
   excludes. `GET /supported` on the public facilitator returns
   `extra: {"areFeesSponsored": true}` for Stellar and nothing about the
   ceiling. Publishing `maxTransactionFeeStroops` in that `extra` would let a
   client simulate, compare, and pick a facilitator that will take the payment
   before it is refused.

If the hosted facilitator's value is set somewhere other than this repository,
tell me where and I will move that part. I can send a PR for the README wording
or the `/supported` field.
