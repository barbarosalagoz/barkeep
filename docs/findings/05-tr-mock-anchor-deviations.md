# Four places the TR Mock Anchor differs from its own documentation

**Status:** observed while integrating, recorded 2026-09-11 (commit 964a204).
Not reported to the anchor's maintainers. The repo dates these notes to 11
September and does not record a later re-confirmation. A "confirmed on 13
September" claim would need a run that is not in the record.

## What I expected

The TR Mock Anchor at `tr-mock-anchor.fly.dev` is the Rise In sandbox for a
TRY to USDC ramp on Testnet. It publishes an `/llms-full.txt` describing its
endpoints, and it speaks SEP-1, SEP-10, SEP-38 and SEP-6. I integrated it
through the portable SEP path only, no partner API. I took the anchor for a
sandbox that would match its own documents, so I did not plan to check one
source against another. I expected the documented shapes, the `/sep6/info`
shapes and the live responses to agree.

## What I observed

They disagree in four places.

1. The withdraw response. `/llms-full.txt` documents the memo field as
   `memo_id`. The live endpoint returns the SEP-6 spec fields `memo` and
   `memo_type`.
2. Deposit limits. `/llms-full.txt` lists 10 to 10,000. `/sep6/info` says 0.5
   to 300, in USDC. The deposit endpoint itself enforces 50 to 3,000 TRY.
   Three sources, three ranges.
3. The `pending_trust` status. `/llms-full.txt` omits it. The anchor does emit
   it when the destination account has no trustline for the asset.
4. SEP-6 calls accept an `account` parameter that differs from the JWT's
   subject.

None of these broke the ramp once I had handled them. The first three are
handled in code. The fourth is a note, not a code path.

## How I measured it

The record is thinner than for the other findings. I wrote the four points
into the README's ramp section on 2026-09-11 and moved them to
`docs/SEP_RAMP.md` on 2026-09-14 unchanged. There are no transaction hashes
for them. The live suite creates a throwaway Friendbot key on every run and
records nothing to the repo.

What the code and tests evidence, per point:

1. `packages/web/src/services/anchor/sep6.ts`, `parseWithdrawResponse`,
   accepts `memo` and falls back to `memo_id`, with a comment saying why.
   `anchor.test.ts` ("parses withdraw instructions, accepting memo or
   memo_id") pins both shapes. The live test asserts the live anchor returns
   `memoType` "id" and a numeric `memo`, which is the spec shape.
2. The live test "SEP-6 deposit: below-minimum amounts are rejected with the
   anchor's message" sends 1 TRY and expects `ANCHOR_REJECTED` with "minimum"
   in the message. That shows the endpoint enforces a minimum above 1. It
   also shows the app surfaces the anchor's own message instead of
   pre-checking. It does not capture the 50 to 3,000 range, nor the 10 to
   10,000 and 0.5 to 300 figures from the two documents. Those numbers rest
   on the note alone.
3. `sep6.ts` lists `pending_trust` among the statuses and labels it "Waiting
   for a trustline". `anchor/index.ts`, `watchDeposit`, polls until
   `pending_trust` or completion, adds the trustline and keeps polling, up to
   three times. No test drives the anchor into `pending_trust`. The live
   deposit creates the trustline before starting, so the status is never
   seen there.
4. Nothing in the code or the tests exercises a SEP-6 call whose `account`
   differs from the JWT subject. This one is an observation with no artefact
   behind it.

To reproduce the live behaviour, from `packages/web`:

```sh
npx vitest run anchor.live          # the live suite, needs Testnet
npm run demo:sep                    # every step printed with timestamps
```

And to re-read the two documents against the live endpoint:

```sh
curl -s https://tr-mock-anchor.fly.dev/llms-full.txt
curl -s https://tr-mock-anchor.fly.dev/sep6/info
```

## What it means for other builders

Parse the spec shape and fall back to the documented one, not the other way
round. The spec is what the live server returned. Do not pre-check amount
limits from a document. Send the request and show the anchor's message. Handle
`pending_trust` even if the anchor's docs do not mention it, because SEP-6
defines it and this anchor emits it. Test the `account`-versus-JWT point for
yourself before relying on either behaviour.

More generally: on a sandbox anchor, `/llms-full.txt` is a convenience written
for language models. It was the least accurate of the three sources I had.

## Where it has been reported

Nowhere. `docs/SEP_RAMP.md` calls them "candidates to send to the anchor's
maintainers at Rise In". Before sending, points 2 and 4 need a fresh
measurement with the actual numbers and requests captured, because the repo
holds neither. Points 1 and 3 can be sent as they stand, with the code and
test references above.

## Record

- `docs/SEP_RAMP.md`, "Notes on the mock anchor": the four points as written.
- Commit `964a204` (2026-09-11): where the notes first appeared, in the README; PR #7 / commit `e94de8d` (2026-09-14): moved to `docs/` unchanged.
- `packages/web/src/services/anchor/sep6.ts`: `memo_id` fallback, `pending_trust` status.
- `packages/web/src/services/anchor/index.ts`, `watchDeposit`: the `pending_trust` handling.
- `packages/web/src/services/anchor/anchor.test.ts`: the `memo`/`memo_id` unit test.
- `packages/web/src/services/anchor/anchor.live.test.ts`: the below-minimum deposit case, the withdraw memo shape.
