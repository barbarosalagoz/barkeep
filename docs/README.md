> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# Barkeep documentation

One line per document. Start with the walkthrough if you have no context.

## Design and walkthrough

- [HOW_IT_WORKS.md](HOW_IT_WORKS.md): one payment from opening a tab to the line on the bill, each step naming its file, and the three traps.
- [ARCHITECTURE-v2.md](ARCHITECTURE-v2.md): the design, constraints, dependency and licence table, risks; §4.1 is the audit position and the only place to quote it from.
- [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md): how keys are generated, stored, rotated and destroyed on Testnet and in the Arc mainnet run, the Arc Testnet key loss, and the single points of failure.
- [AI_ASSISTED_DEVELOPMENT.md](AI_ASSISTED_DEVELOPMENT.md): which parts were written with Claude Code, how quality is enforced, and what the author decided.
- [DEPLOYMENTS.md](DEPLOYMENTS.md): the Testnet identities, where keys live and never live, how to redeploy, the passkey registration and signing steps.
- [MIGRATION-stellar-accounts-0.9.0.md](MIGRATION-stellar-accounts-0.9.0.md): what breaks when the account moves off 0.7.2, and why it has not moved yet.

## Findings

Each has the same shape: what I expected, what I observed, how I measured it, what it means for other builders, where it has been reported.

- [01 The public x402 facilitator refuses accounts that enforce a cap on chain](findings/01-x402-public-facilitator-refuses-policy-events.md): confirmed; already upstream as x402#3352, my measurements added there as a comment, fee ceiling filed as x402#3515.
- [02 A 0.7.2 signature verifies on another account with the same key](findings/02-auth-digest-not-account-scoped.md): confirmed; posted as OpenZeppelin/stellar-contracts#897.
- [03 "Audited" covered none of what I deploy](findings/03-what-audited-covers.md): confirmed; my own docs corrected.
- [04 The ed25519 verifier never returns false](findings/04-ed25519-verifier-panics-not-false.md): confirmed for wrong digest and replay, inferred for wrong key; observation 1 in OpenZeppelin/stellar-contracts#897.
- [05 Four places the TR Mock Anchor differs from its documentation](findings/05-tr-mock-anchor-deviations.md): recorded 11 Sep, two of four evidenced in code, not reported.
- [06 The WebAuthn verifier passed its done-test and could never be called by the account](findings/06-webauthn-verifier-sig-data-not-xdr.md): confirmed by simulation, fixed by a redeploy, verified by a passkey transfer on chain; Barkeep's bug, nothing to report.

## Evidence

- [EXTERNAL_USAGE.md](EXTERNAL_USAGE.md): usage by anyone other than the author, kept apart from the records below. Empty today.

- [../deployments/testnet.json](../deployments/testnet.json): contract ids, wasm hashes, and every done-test's transaction hashes, ledgers and refusal codes on the 0.7.2 deployment.
- [../deployments/testnet-v09.json](../deployments/testnet-v09.json): the same on the `4529d70` deployment, plus the client-flow and cross-account replay cases.
- [../packages/mcp-server/scripts/](../packages/mcp-server/scripts/): the Testnet done-test scripts those hashes came from; `tab-lifecycle`, `tab-tools`, `x402-spike`, `pay-and-fetch`, `payee-allowlist`, `demo-stack`, `extend-ttl`, `add-passkey-rule`, `passkey-sign`, `passkey-virtual-authenticator`, `remove-context-rule`, and the two `v09-*` scripts.
- [../scripts/verify-verifiers-testnet.sh](../scripts/verify-verifiers-testnet.sh): read-only check that the deployed verifiers accept a known-good fixture and refuse a bad one.

## Upstream

- [upstream/stellar-contracts-v0.9.0-client-flow-testnet.md](upstream/stellar-contracts-v0.9.0-client-flow-testnet.md): Testnet confirmation of the v0.9.0 client flow, posted 2026-09-18 as [OpenZeppelin/stellar-contracts#897](https://github.com/OpenZeppelin/stellar-contracts/issues/897).
- [upstream/x402-3352-comment.md](upstream/x402-3352-comment.md): the T3/T4 measurements, posted 2026-09-18 as a [comment on x402#3352](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326).
- [upstream/x402-fee-ceiling-default.md](upstream/x402-fee-ceiling-default.md): the 50,000-stroop fee ceiling default, posted 2026-09-18 as [x402#3515](https://github.com/x402-foundation/x402/issues/3515).

## Grant application (drafts)

- [INSTAWARD_APPLICATION.md](INSTAWARD_APPLICATION.md): the SCF Instaward draft, with its working appendices.
- [INSTAWARD_GAPS.md](INSTAWARD_GAPS.md): what the author must do before sending it.

## Earlier work, preserved

- [YELLOW_BELT.md](YELLOW_BELT.md): the PromptRail Yellow Belt submission record, kept under the old name because that is the name it was submitted and verified under.
- [SUBMISSION_PACK.md](SUBMISSION_PACK.md): the paste-ready text Rise In received, and the Orange Belt notes.
- [SEP_RAMP.md](SEP_RAMP.md): the TRY on/off-ramp through SEP-1, 10, 38 and 6 against the TR Mock Anchor.
- [screenshots/](screenshots/): the belt-era screenshots.
