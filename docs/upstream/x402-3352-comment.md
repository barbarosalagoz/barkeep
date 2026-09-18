# Posted 2026-09-18 as a comment on x402-foundation/x402#3352. Drafted by Claude from docs/findings/01.

https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326

Everything below the `---` line is the comment as posted.

Record: `deployments/testnet.json` (`doneTests.x402Spike`); script
`packages/mcp-server/scripts/x402-spike-testnet.mjs` (commit 27ab3d6); the
filter in `packages/mcp-server/src/facilitator.ts`, `onlyAssetEvents`.

Checked before posting:

- Checked 2026-09-18: the T4 link returns 200 from `api.stellar.expert`;
  Horizon says successful, ledger 4649844, fee charged 276,476.
  `validateSimulationEvents` is byte-identical in the 2.25.0 and 2.26.0 builds
  and unchanged on `main` (c8c71f2).
- The two-topic reading of `spending_limit_enforced` comes from the
  stellar-accounts 0.7.2 source, not from the recorded event. The comment says
  so.

---

> AI-assisted. The test script and the first draft of this text were written
> with an AI coding assistant (Claude Code). I ran the script myself, checked
> each transaction below on Horizon and a block explorer, and reviewed and
> edited this text before posting.

I hit this independently on Testnet on 2026-09-13, with `@x402/stellar` 2.25.0
and an OpenZeppelin `stellar-accounts` 0.7.2 smart account whose
`spending_limit` policy publishes `spending_limit_enforced` from inside
`__check_auth`. Same payload in both rows, `exact`, amount 1000, 2.25.0 run in
process with `maxTransactionFeeStroops` raised to 2,000,000:

| Case | Event check | Result |
| --- | --- | --- |
| T3 | Stock | Refused: `invalid_exact_stellar_payload_event_not_transfer` |
| T4 | Upstream function unchanged, handed only the events emitted by `requirements.asset` | Settled: [`c02f9035…4aaf`](https://stellar.expert/explorer/testnet/tx/c02f9035c0eb0250a619633c192aca4e43996a89dad927f7236f7508aab64aaf), ledger 4649844 |

T3 never reached the ledger, so it has no hash. The simulation held two
contract events, `spending_limit_enforced` from the policy contract and then
`transfer` from the token. T4's events read back from RPC are the same two, the
transfer being smart account to seller for 1000.

The T4 filter:

```ts
events.filter((d) => {
  const event = d.event();
  const contractId = event.contractId();
  const emitter = contractId ? StrKey.encodeContract(contractId) : null;
  return event.type().name !== "contract" || emitter === asset;
})
```

This supports #3399's approach: key on the emitting contract, then apply the
existing transfer rules to the asset's events only. A non-transfer event from
the asset is still refused, which skipping every non-`transfer` event would not
give you.

One inference, not measured: in the 0.7.2 source `SpendingLimitEnforced` has two
topics, the event name and the account address, so I expect the refusal comes
from the `topics.length < 3` branch and not the `symbol !== "transfer"` one. I
did not record which branch returned.

The public facilitator refused this payer earlier, on the fee ceiling. I am
filing that separately.
