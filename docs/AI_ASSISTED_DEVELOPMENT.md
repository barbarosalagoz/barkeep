# AI-assisted development

Much of Barkeep was written with an AI coding assistant, **Claude Code**,
running Anthropic's Claude models. This file covers:

- which parts that applies to, as far as the repository records it;
- how quality is enforced;
- what the author wrote or decided.

**[BARBAROS: CONFIRM]** marks a question that only the author can answer. The
repository does not record those answers, so this file does not guess them.

## What the record shows

Figures below are from `git log` on `main` at `ef0dc73`, counted 2026-09-25.

- **47 of 62 commits** carry a `Co-Authored-By: Claude …` trailer. Squash-merged
  PRs keep the trailers of the commits inside them. The trailers name these
  models:
  - Claude Opus 5, 2026-08-28 to 2026-09-14;
  - Claude Fable 5 and 5.1, 2026-09-01 and 2026-09-14 to 2026-09-15.
- **The 15 commits without a trailer:**
  - 12 on the first day, 2026-08-24: the PromptRail White Belt dApp (the
    Freighter connection, balance, payments and dashboard), its docs and
    screenshots, and one merge commit.
  - 2 on 2026-08-28: a screenshot update and the merge commit of PR #1.
  - The squash of PR #10 (2026-09-18). Its files carry their own "Drafted by
    Claude" headers.
  - A missing trailer does not prove the work had no AI help.
    **[BARBAROS: CONFIRM]** whether any of those 15 were AI-assisted.
- **Every commit touching the product has a trailer.** That covers
  `contracts/barkeep-*`, `packages/mcp-server`, `packages/tab-read`,
  `packages/core`, `scripts/` and `deployments/`.
- **Docs that say so themselves:**
  - `docs/README.md` and the findings open with a note that they are drafts
    for the author's review, with the prose still to be rewritten by the
    author.
  - The three upstream posts in `docs/upstream/` open with "Drafted by Claude".
  - Each upstream post, as published, carries an AI-assisted disclosure. See
    for example
    [x402#3352 (comment)](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326).
  - `docs/INSTAWARD_*.md`, this file, `docs/KEY_MANAGEMENT.md` and
    `docs/EXTERNAL_USAGE.md` were drafted with Claude Code (Claude Opus 5.5) on
    2026-09-25.

Summary by area:

| Area | Written with Claude Code? | Source of that answer |
| --- | --- | --- |
| Contracts (`contracts/barkeep-*`) | Yes | Commit trailers |
| MCP server, x402 client scheme, facilitator fork, seller | Yes | Commit trailers |
| `@barkeep/core`, `@barkeep/tab-read` | Yes | Commit trailers |
| Testnet done-test scripts and their recorded results | Yes, written with it. The author ran them | Commit trailers; [BARBAROS: CONFIRM] that you ran them |
| Payment Tracker contract, Yellow Belt dApp features (2026-08-28) | Yes | Commit trailers |
| White Belt dApp (2026-08-24) | Not recorded | No trailer. [BARBAROS: CONFIRM] |
| Findings, walkthrough, architecture, upstream posts | Drafted with it | The docs' own headers |
| Load-bearing text in grant applications | To be rewritten by the author | `docs/INSTAWARD_APPLICATION.md` markers |

## How quality is enforced

These are the checks that exist in the repository today:

- **CI on every PR to `main`** ([ci.yml](../.github/workflows/ci.yml)). It
  runs `cargo test --workspace`, ESLint, the TypeScript typecheck, the build
  and the offline unit tests. On 2026-09-25 at `ef0dc73` that was 70 contract
  tests passing (6 ignored) and 132 unit tests passing.
- **Branch discipline.** Changes land through PRs. **[BARBAROS: CONFIRM]**
  whether branch protection requires green CI before merging. That is a
  repository setting, and it is not visible in the files.
- **On-chain done-tests.**
  - Every behaviour claimed about the contracts was run on Testnet. The hash,
    the ledger and, for a refusal, the contract error code are recorded in
    [deployments/testnet.json](../deployments/testnet.json).
  - Refusals are forced on chain, not only simulated. For example, the
    over-cap payment is submitted anyway so that `#3221` appears in a real
    failed transaction.
  - These scripts need keys and the network, so they run by hand, not in CI.
- **A licence gate.** The build fails if a bundled dependency is unlicensed,
  or uses a licence outside the allow-list (`packages/web/build/`).
- **Tests that check what should not happen.**
  - `@barkeep/core` must not depend on `@stellar/*`
    (`no-stellar-dependency.test.ts`).
  - The MCP state files must contain no key material (`server.test.ts`).
  - The money tools must carry the confirmation flag.
- **Corrections kept on the record.** The findings keep the cases where the
  code, or the docs, were wrong:
  - [Finding 06](findings/06-webauthn-verifier-sig-data-not-xdr.md): a
    verifier passed its done-test but could never be called by the account.
  - [Finding 03](findings/03-what-audited-covers.md): an audit claim that
    was not true.
  - Commit `5ebf471`: a withdrawn "stale reference" claim.

**What does not exist here:**
- mutation testing;
- fuzzing or property-based tests;
- static analysis beyond ESLint and `cargo`'s own checks;
- a secret scanner in CI;
- external review of any kind.

The Arc rebuild does add a mutation check, Slither and a secret scan to its
CI ([barkeep-arc](https://github.com/barbarosalagoz/barkeep-arc)). None of
that covers this repository.

## What the author wrote or decided

**[BARBAROS: CONFIRM].** Replace each bullet with your own answer. They are
prompts, not claims.

- **Product decisions.** For example: building on OpenZeppelin
  `stellar-accounts` instead of writing custody logic; making the payee list
  fail closed; staying on 0.7.2 until 0.9.0 is published; keeping mainnet
  closed. Which of these did you decide, and which did you accept from a
  suggestion?
- **What you review before merging.** Do you read every diff? Do you rerun
  the Testnet scripts yourself? What makes you reject a change?
- **What you wrote or re-derived by hand.** For example, any contract logic,
  test cases, or the measurements behind the upstream reports.
- **Upstream reports.** The posts say you ran the scripts and checked the
  results. Say what that involved.
- **Where the assistant was wrong, and how you caught it.** Findings 03 and 06
  are candidates. Say who found each one.
