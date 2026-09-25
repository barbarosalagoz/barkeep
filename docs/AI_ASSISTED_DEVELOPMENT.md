# AI-assisted development

Much of Barkeep was written with an AI coding assistant, **Claude Code**,
which runs Anthropic's Claude models. This file covers three things:
- which parts that applies to, as far as the repository records it;
- how quality is enforced;
- what the author wrote or decided.

Where the record is silent, this file says so rather than guessing.

Barkeep runs on **Stellar Testnet only**. Its contracts are **unaudited**, and
it has **no external users yet**.

> Sections 1–5 are written from Barbaros's own notes in Turkish; English translation and light editing assisted by AI.

(This refers to sections 1–5 of the
[Instaward application](INSTAWARD_APPLICATION.md#in-my-own-words), the
sections in the author's own voice.)

## What the record shows

The figures below come from `git log` on `main` at `ef0dc73`, counted on
2026-09-25.

**Commit trailers.** 47 of 62 commits carry a `Co-Authored-By: Claude …`
trailer. Squash-merged PRs keep the trailers of the commits inside them. The
trailers name these models:
- Claude Opus 5, from 2026-08-28 to 2026-09-14;
- Claude Fable 5 and 5.1, on 2026-09-01 and from 2026-09-14 to 2026-09-15.

**The 15 commits without a trailer:**
- 12 on 2026-08-24: the PromptRail White Belt dApp (the Freighter
  connection, balance, payments and dashboard), its docs and screenshots,
  and one merge commit;
- 2 on 2026-08-28: a screenshot update and the merge commit of PR #1;
- the squash of PR #10 (2026-09-18). Its files carry their own "Drafted by
  Claude" headers.

A missing trailer does not show that a commit had no AI help. This file makes
no claim either way for those 15.

**Every commit touching the product has a trailer.** That covers
`contracts/barkeep-*`, `packages/mcp-server`, `packages/tab-read`,
`packages/core`, `scripts/` and `deployments/`.

**Later work on the `docs/instaward-application` branch**, from 2026-09-25,
carries `Co-Authored-By: Claude Opus 5.5` trailers. That includes:
- the per-tab agent keys (`5d0b427`);
- `docs/KEY_MANAGEMENT.md`;
- `docs/EXTERNAL_USAGE.md`;
- the Instaward documents, apart from sections 1–5 of the application.

**Docs that say so themselves:**
- `docs/README.md` and the findings open with a note that they are drafts
  for the author's review.
- The three upstream posts in `docs/upstream/` open with "Drafted by Claude".
- Each upstream post, as published, carries an AI-assisted disclosure. See
  for example
  [x402#3352 (comment)](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326).

### By area

| Area | Written with Claude Code? | Source of that answer |
| --- | --- | --- |
| Contracts (`contracts/barkeep-*`) | Yes | Commit trailers |
| MCP server, x402 client scheme, facilitator fork, seller, per-tab keys | Yes | Commit trailers |
| `@barkeep/core`, `@barkeep/tab-read` | Yes | Commit trailers |
| Testnet done-test scripts | Yes | Commit trailers |
| Payment Tracker contract, Yellow Belt dApp features (2026-08-28) | Yes | Commit trailers |
| White Belt dApp (2026-08-24) | Not recorded | No trailer |
| Findings, walkthrough, architecture, upstream posts | Drafted with it | The docs' own headers |
| Findings 03 and 06: what they found | Found by Barbaros. | The author |
| Instaward application, sections 1–5 | Written from Barbaros's own notes in Turkish; English translation and light editing assisted by AI | The author |
| The rest of the Instaward application, this file, KEY_MANAGEMENT, EXTERNAL_USAGE | Drafted with it from the repository record | Commit trailers |

## How quality is enforced

These are the checks that exist in the repository today.

**CI on every PR to `main`** ([ci.yml](../.github/workflows/ci.yml)). It runs:
- `cargo test --workspace`: 70 passing, 6 ignored;
- ESLint;
- the TypeScript typecheck;
- the build;
- the offline unit tests: 143 passing, in 18 files.

The counts are from the `docs/instaward-application` branch on 2026-09-25.

**Branch protection: none.** Checked through the GitHub API on 2026-09-25:
`main` is not protected and has no rulesets, so a green CI run is not
required before a merge. Changes do land through PRs, but that is practice,
not something the repository enforces.

**On-chain done-tests.**
- Every behaviour claimed about the contracts was run on Testnet.
- Each run's hash and ledger are recorded in
  [deployments/testnet.json](../deployments/testnet.json). For a refusal, the
  contract error code is recorded too.
- Refusals are forced on chain, not only simulated. For example, the over-cap
  payment is submitted anyway, so `#3221` appears in a real failed
  transaction.
- These scripts need keys and the network, so they are run by hand, not in
  CI.

**Licence gate.** The build fails if a bundled dependency is unlicensed, or
uses a licence outside the allow-list (`packages/web/build/`).

**Tests that check what must not happen:**
- `@barkeep/core` must not depend on `@stellar/*`
  (`no-stellar-dependency.test.ts`);
- the MCP state directory must hold no key material (`server.test.ts`,
  `agentKeys.test.ts`);
- the money tools must carry the confirmation flag;
- a destroyed per-tab key must not be replaced by another key
  (`agentKeys.test.ts`).

**Corrections stay on the record:**
- [Finding 06](findings/06-webauthn-verifier-sig-data-not-xdr.md): a
  verifier passed its done-test but could never be called by the account.
  Found by Barbaros.
- [Finding 03](findings/03-what-audited-covers.md): an audit claim that was
  not true. Found by Barbaros.
- Commit `5ebf471`: a "stale reference" claim, withdrawn.

**What does not exist here:**
- mutation testing;
- fuzzing or property-based tests;
- static analysis beyond ESLint and `cargo`'s own checks;
- a secret scanner in CI;
- branch protection;
- external review of any kind.

The Arc rebuild does add a mutation check, Slither and a secret scan to its
CI ([barkeep-arc](https://github.com/barbarosalagoz/barkeep-arc)). None of
them covers this repository.

## What the author wrote or decided

This section records only what the author has stated.

- **The hard spending cap was the starting decision.** It was set when the
  project's first architecture was drawn up (application, section 1).
- **Sections 1–5 of the Instaward application** are the author's own text.
  They were written from notes in Turkish, then translated and lightly edited
  with AI assistance.
- **Findings 03 and 06:** Found by Barbaros.
- **The narrow scope and the workshop format** are the author's choice, made
  as a trainer (application, section 3).

The record does not state the author's per-change review practice, or which
lines of code the author wrote by hand, so this file makes no claim about
either.
