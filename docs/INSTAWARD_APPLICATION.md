> **DRAFT. Not submitted, and not to be submitted as written.** Prepared 2026-09-25 from the repo record, the public GitHub record and SCF's own handbook. Every sentence marked **[BARBAROS: REWRITE IN YOUR OWN VOICE]** is a set of notes, not prose. What you must do before sending is in [INSTAWARD_GAPS.md](INSTAWARD_GAPS.md).

# Barkeep: SCF Instaward application (draft)

## How to read this draft

**Where the field order comes from.** SDF does not publish the Instaward form. Checked 2026-09-25: no official page lists its fields, their order or any character limits. The order below follows what the official rules require a submission to contain:

| Order | Section | Rule it comes from |
| --- | --- | --- |
| 1 | The Chapter Lead who assists with the submission | [Instawards Official Rules §7](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules): "the Applicants will be required to identify the Chapter Lead who assists with the submission" |
| 2 | Chapter participation | [Rules §2 and §4](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules): "Are actively participating in a local Stellar Ambassador Chapter" |
| 3 | A concrete deliverable | [Rules §5](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules): "A concrete technical or product deliverable" |
| 4 | Relevance to Stellar | Rules §5: "Direct relevance to the Stellar network" |
| 5 | Success criteria | Rules §5: "Clear success criteria that can be evaluated at the end of the sprint" |
| 6 | A scope that fits the amount | Rules §5: "A scope that matches the requested award amount" |
| 7 | A 30-day plan | [Rules §3](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules): "Define a clear, achievable 30-day sprint scope aligned with Instaward tiers" |

Sections 8 to 13 cover what the SCF panel feedback asks for: evidence, composition, competition, risks, AI disclosure and what happens after the sprint.

When the Chapter Lead sends you the real form, put these sections into its order. Delete anything the form does not ask for.

**Amount.** The first award is usually "$1,000 – $5,000 USD, paid in XLM". Follow-on awards can bring the total "up to $15,000 … in the aggregate" ([Rules §6](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules)). The ~$30k ceiling in the panel feedback belongs to a different, larger programme and does not apply here. This draft asks for an amount inside the $1,000–$5,000 range.

**Labels used throughout:**
- **[TEAM · TESTNET]**: activity I generated myself on Stellar Testnet.
- **[TEAM · ARC MAINNET]**: activity I generated myself on another chain's mainnet.
- **[EXTERNAL]**: activity by independent third parties. **There is none today.**

---

## 1. Applicant and Chapter Lead

- **Applicant:** Barbaros Emre Alagöz, a single-person team. GitHub: [barbarosalagoz](https://github.com/barbarosalagoz).
- **Chapter:** Stellar Türkiye Chapter ([chapter page](https://stellar.gitbook.io/ambassador-program/chapters/europe-and-middle-east/turkiye-chapter)).
- **Chapter Lead:** [BARBAROS: the name of the Chapter Lead who is actually helping you. The chapter page lists "İrem Koçi, Rise In, Chapter Lead". Confirm with them before you name them.]
- **KYC:** payment requires SDF KYC ([Rules §7](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules), [stellar.org/bd-kyc](https://stellar.org/bd-kyc)). [BARBAROS: confirm you are ready for this.]

## 2. Chapter participation

[BARBAROS: fill this in from your own record. Nothing in the repo shows chapter participation, so this draft makes no claim about it.]

- Rules §4 says: "Active engagement goes beyond joining a Discord or attending a single event." Its examples are meetups, "Sharing progress updates or demos with the chapter", and helping with chapter programming.
- Things you can point to:
  - The Rise In Journey to Mastery belts. Yellow Belt was submitted under the name PromptRail ([docs/YELLOW_BELT.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/YELLOW_BELT.md), [docs/SUBMISSION_PACK.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/SUBMISSION_PACK.md)).
  - The TR Mock Anchor integration ([docs/SEP_RAMP.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/SEP_RAMP.md)).
  - [BARBAROS: the hackathon. Give its name, date, organiser, and your result with a link. The repo only calls it "Hackathon prep" in [PR #7](https://github.com/barbarosalagoz/barkeep/pull/7), so it is not named anywhere.]
  - [BARBAROS: any meetups or demos you gave, with dates.]

## 3. Problem

**[BARBAROS: REWRITE IN YOUR OWN VOICE]**

Notes:
- An agent that pays for HTTP requests (x402) needs a key that can spend.
- Today that key is usually a plain G-account key. A plain key has no on-chain limit, so a bug or a prompt injection can spend everything it holds.
- Limits kept in the prompt or in the agent's server are not enforced where the money is ([HOW_IT_WORKS.md, "The problem in one paragraph"](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/HOW_IT_WORKS.md)).
- Stellar already has what is needed to enforce limits on chain. OpenZeppelin `stellar-accounts` provides context rules and a spending-limit policy.
- What I measured, and what builders hit in practice, is that the pieces do not fit together yet:
  - The stock x402 client cannot sign as a smart account ([x402#3158](https://github.com/x402-foundation/x402/issues/3158)).
  - The public facilitator refuses a payment that emits a policy event ([x402#3352](https://github.com/x402-foundation/x402/issues/3352)).
  - The public facilitator's fee ceiling is below what a smart-account transfer costs ([x402#3515](https://github.com/x402-foundation/x402/issues/3515)).
- There is no payee restriction in `stellar-accounts`. The spending limit caps how much the agent spends, not who it pays.
- No market-size claim. None is sourced.

## 4. The sprint deliverable

**[BARBAROS: REWRITE IN YOUR OWN VOICE]**. This is the scope choice. The draft uses the recommended Option B. Option A is in [Appendix D](#appendix-d-the-two-scope-options).

**Deliverable: the Barkeep tab starter kit and a Türkiye chapter workshop.** It has three parts:
1. **A template repo.** A builder runs one command on Stellar Testnet and gets:
   - an OpenZeppelin smart account;
   - an agent session key limited by a spending-limit policy and a payee allowlist;
   - a local x402 seller;
   - one paid request.
2. **A role-based guide in English and Turkish.** One section each for the agent builder, the seller and the human signer.
3. **One chapter workshop.** Attendees open a tab and make a payment from their own keys.

Notes for the rewrite:
- Why narrow: one repo, one guide, one event. No new contracts. The contracts already exist and are tested.
- Why Instaward and not a larger grant: it is my first external usage, and the rules fund "early execution support" (Rules §2).
- Testnet only. No real funds and no mainnet custody, which keeps the regulatory question out of scope (see §11).

## 5. Relevance to Stellar

- It is built on OpenZeppelin `stellar-accounts` context rules and the `spending_limit` policy. The account's `__check_auth` enforces them on chain ([ARCHITECTURE-v2.md §4](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/ARCHITECTURE-v2.md)).
- It pays through x402 `exact` on Stellar using `@x402/stellar` ([ARCHITECTURE-v2.md §3.1](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/ARCHITECTURE-v2.md)).
- It adds a payee-allowlist policy that `stellar-accounts` does not ship ([contracts/barkeep-payee-allowlist](https://github.com/barbarosalagoz/barkeep/tree/ef0dc73/contracts/barkeep-payee-allowlist)).
- The friction it documents is already filed upstream: x402#3352, x402#3515 and OpenZeppelin/stellar-contracts#897 (see §8).

## 6. Why this approach, and why not the existing path

**[BARBAROS: REWRITE IN YOUR OWN VOICE]**. This is the design reasoning.

**Why not the existing path, in one sentence (draft):**
> The existing path, OpenZeppelin's smart-account docs plus the x402 quickstart, never shows a builder how to give an agent a key that is capped and payee-limited on chain, and a builder who tries it with a smart account fails first at the x402 client ([x402#3158](https://github.com/x402-foundation/x402/issues/3158)) and then at the facilitator ([x402#3352](https://github.com/x402-foundation/x402/issues/3352), [x402#3515](https://github.com/x402-foundation/x402/issues/3515)) with no explanation.

Design-reasoning notes:
- **Put the limit where the money is.** The limit is contract state checked inside `__check_auth`, not in the prompt, the MCP server or a vendor's enclave ([HOW_IT_WORKS.md, "Why a smart account"](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/HOW_IT_WORKS.md)).
- **The payee list fails closed.** A tab opened with no payees is refused unless `allow_any_payee: true` is set explicitly. On chain this shows as `#3902 EmptyAllowlist` ([tx b195c7ff…](https://stellar.expert/explorer/testnet/tx/b195c7ff78737ad4a4c5ec933ac613d532057aa91e5c52ecc18aa2d009e4a0b6)).
- **The allowlist emits no event when a payment passes**, so it does not add a second event for the facilitator to refuse ([finding 01](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/findings/01-x402-public-facilitator-refuses-policy-events.md)).
- **The agent key cannot change its own limits.** It is refused with `#3002` ([tx ff51d3a1…](https://stellar.expert/explorer/testnet/tx/ff51d3a16cef73ef922a1d9f0d3537362a85e0f02dc4b4d6e6b2bb71ca571afc)).
- **The facilitator is a fork with two checks relaxed**, and each relaxation is commented next to the upstream check it replaces ([packages/mcp-server/src/facilitator.ts](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/packages/mcp-server/src/facilitator.ts)). That is a workaround, not the goal. The kit will switch to the stock facilitator once upstream accepts smart-account payers.

## 7. Composition with x402 and OpenZeppelin smart accounts

| Layer | What Barkeep uses | Its own code | Status |
| --- | --- | --- | --- |
| Account | OpenZeppelin `stellar-accounts` =0.7.2: context rules, `spending_limit` | Thin account contract, verifiers | Deployed on Testnet ([deployments/testnet.json](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/deployments/testnet.json)) |
| Payee limit | Plugs into the `stellar-accounts` policy interface | `barkeep-payee-allowlist` | Deployed on Testnet, 19 unit tests |
| Human signer | WebAuthn passkey through a verifier contract | `barkeep-verifier-webauthn`, signing page | A passkey-signed transfer on Testnet: [tx f6a66a60…](https://stellar.expert/explorer/testnet/tx/f6a66a603e160bb63e539b458acec6b6245f930d54ac8dc2918108397999ce17) |
| Payment | x402 v2 `exact`, `@x402/stellar` 2.25.0 | Client scheme that signs as the smart account ([x402Scheme.ts](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/packages/mcp-server/src/x402Scheme.ts)). Facilitator fork with 2 relaxations | Works only with a facilitator that accepts smart-account payers |
| Agent interface | MCP (stdio) | `open_tab`, `pay_and_fetch`, `tab_status`, `close_tab` | Testnet |
| Upcoming account version | `stellar-accounts` v0.9.0 branch (`4529d70`) | Parallel deployment | Client flow confirmed and posted as [stellar-contracts#897](https://github.com/OpenZeppelin/stellar-contracts/issues/897) |

**Not composed today:**
- MPP (`@stellar/mpp`). Reviewed and deferred in [ARCHITECTURE-v2.md §3.2](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/ARCHITECTURE-v2.md).
- The OpenZeppelin Relayer x402 facilitator. Whether it accepts a smart-account payer has not been measured.

## 8. What exists today, with evidence

The full claim-by-claim table is [Appendix B](#appendix-b-evidence-audit).

### [EXTERNAL] Independent third-party usage

**None.** There are no external users, no partners, no revenue and no third-party deployments. The GitHub repo has 0 stars and 0 forks (checked 2026-09-25).

### [TEAM · TESTNET] Barkeep on Stellar Testnet

All of the following was generated by me with my own keys on Stellar Testnet. The hashes are in [deployments/testnet.json](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/deployments/testnet.json).

| Behaviour | Result | Evidence |
| --- | --- | --- |
| Transfer under the cap | Succeeds | [tx 15333d0a…](https://stellar.expert/explorer/testnet/tx/15333d0af7b85b0e1097f9ef70e59702f522199e597af154940150d1f07420da) |
| Transfer over the cap | Refused, `#3221 SpendingLimitExceeded` | [tx 6f001e4a…](https://stellar.expert/explorer/testnet/tx/6f001e4a2266bedf8b016e4fde5a978cc4ae06a5f22a79545fe67d7b51ca0f47) |
| Transfer after expiry | Refused, `#3002` | [tx b253a6f8…](https://stellar.expert/explorer/testnet/tx/b253a6f86e311cc5704d83b7a507bc099d688513f398547614fb9cc40295be46) |
| Transfer after `close_tab` | Refused, `#3000 ContextRuleNotFound` | [tx afda2b58…](https://stellar.expert/explorer/testnet/tx/afda2b58582ea1fc8a88a4cd1d6b3f037d04f2083aa1c959d84334497041e877) |
| x402 payment through `pay_and_fetch` | Paid 0.0001 TAB | [tx 18baa88e…](https://stellar.expert/explorer/testnet/tx/18baa88eedf273de301ef7e64b9f3192f186a8c6c36595e72662280d2b565fcb) |
| x402 payment over the remaining cap, forced on chain | Refused, `#3221` | [tx a5fc48c6…](https://stellar.expert/explorer/testnet/tx/a5fc48c638ec7ec3ef743115c0e3785754245cf38e8d2edaa5fcc8718368b34d) |
| Payee on the allowlist | Paid | [tx 42c1ad39…](https://stellar.expert/explorer/testnet/tx/42c1ad39a2baefc37a9e78ea0a7d0df5f86c696f6396085a1492e6699801a605) |
| Payee not on the allowlist | Refused, `#3901 PayeeNotAllowed` | [tx 681ae9ea…](https://stellar.expert/explorer/testnet/tx/681ae9eae8d09c83f49b8977755687deae564458c4680589d9f88e0ab4a7b4d0) |
| Full demo stack through the MCP wrapper, 2026-09-14 | 3 payments, then close | [tx 7f0ec6c1…](https://stellar.expert/explorer/testnet/tx/7f0ec6c1b882a5af712bab10771afad45ea02b58c3ec207829307267ea13d573), [tx a63f510b…](https://stellar.expert/explorer/testnet/tx/a63f510ba511148b82260d64a72f66ca2c2936c21b3b91626ffc4968c6fef1ab) |
| Public facilitator vs a capped smart account | Refused (fee ceiling; event check) | `doneTests.x402Spike` T2/T3; settles with both relaxed: [tx c02f9035…](https://stellar.expert/explorer/testnet/tx/c02f9035c0eb0250a619633c192aca4e43996a89dad927f7236f7508aab64aaf) |

**Tests**, run locally on 2026-09-25 at `ef0dc73`:
- `cargo test --workspace`: 70 passed, 6 ignored, 0 failed.
- `npm run test:unit`: 132 passed in 17 files.
- CI runs both suites plus lint, typecheck and build. It was green on `main` for the last push ([run 35324655641](https://github.com/barbarosalagoz/barkeep/actions/runs/35324655641)).
- There is no mutation testing in this repo.

### [TEAM · ARC MAINNET] The same design on Circle's Arc mainnet

This is not Stellar. It is included only to show that the design ran with real funds, and every item was generated by me. The source is [barkeep-arc docs/MAINNET.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/MAINNET.md), dated 2026-09-24.

| Behaviour | Evidence |
| --- | --- |
| 3 × 0.001 USDC x402 payments, settled by Circle's hosted facilitator | [0x2b26d71f…](https://explorer.arc.io/tx/0x2b26d71fda48dcd2eed10b26040858735de4a8a145d64185f44a5e9bf344ba26), [0xfcc39bc0…](https://explorer.arc.io/tx/0xfcc39bc01a99399c44645cccebe49dec6a8cd44970f6ade0635c0fa5fceb43fb), [0x210a8dfb…](https://explorer.arc.io/tx/0x210a8dfbaf66880d34fbaaabbf766ee619dd1d382cab7509e816ec534091ae53) |
| Over the per-call maximum: reverted | [0x332409fb…](https://explorer.arc.io/tx/0x332409fb88ca5a3bfab25917ed7c38872ad6b46e4ede71a6fb1feb4bf3614e27) |
| Payee not on the list: reverted | [0xe2a02e84…](https://explorer.arc.io/tx/0xe2a02e84b920dc6ecd795697e48f143c3f4fe49bf0c564e515f5b48705a14c50) |
| After expiry: reverted | [0x3d966f20…](https://explorer.arc.io/tx/0x3d966f2090a7ab11ff5209a7071145842217a568b606e9b6522d8d169127242a) |
| Close, and the balance swept back | [0xa0be0731…](https://explorer.arc.io/tx/0xa0be0731a74afeb513012204f0106caae8a85b059667c49e1e3f6e0c6b2592bb) |

**Upstream contributions** (all mine, all still open, no maintainer reply as of 2026-09-25):

| Item | My role | Status |
| --- | --- | --- |
| [OpenZeppelin/stellar-contracts#897](https://github.com/OpenZeppelin/stellar-contracts/issues/897) | Author. Confirmed the v0.9.0 client flow on Testnet | Open, 0 comments |
| [x402#3352](https://github.com/x402-foundation/x402/issues/3352) | [Comment](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326) with the T3/T4 measurements. The issue was filed by another builder | Open. The fix is in PR [#3399](https://github.com/x402-foundation/x402/pull/3399) (not mine), still unreviewed |
| [x402#3515](https://github.com/x402-foundation/x402/issues/3515) | Author. The fee-ceiling default | Open, 0 comments. `@x402/stellar` 2.27.0 still defaults to 50,000 stroops |
| [x402#3158](https://github.com/x402-foundation/x402/issues/3158) | None. Barkeep works around it in [x402Scheme.ts](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/packages/mcp-server/src/x402Scheme.ts) | Open. The fix is in PR [#3018](https://github.com/x402-foundation/x402/pull/3018) (not mine), unreviewed since 2026-08-01 |

## 9. Success criteria and acceptance tests

Every criterion can be checked at the end of the sprint by someone other than me.

| # | Criterion | Acceptance test | Evidence produced |
| --- | --- | --- | --- |
| S1 | The kit opens a capped, payee-limited tab on Testnet from a clean machine | A person who is not me follows the README on a fresh machine: tab open and one paid request in ≤ 30 minutes (timed, recorded) | Tx hashes; a screen recording |
| S2 | The kit's checks run in CI | A CI job builds the kit and runs its offline tests on every PR | CI run link |
| S3 | Guide in English and Turkish | Both are merged. Every command in the guide is run by CI, or by hand with its output recorded | Commit link |
| S4 | Workshop held through the Türkiye chapter | Event page or chapter announcement, with a date | Link |
| S5 | **External usage, kept separate from mine** | Attendees open a tab and make one payment **from keys they generated themselves**. Target: 10 people (a target, not a claim). Each hash is published only with that person's written consent, in a table separate from my own runs | Tx hashes; a consent record |
| S6 | Feedback | An anonymous short form. The results are published unedited, including the negative ones | Link |

## 10. Timeline (30 days)

Day 1 is the approval date. The calendar dates assume approval on Monday 2026-10-12 and move with it.

| Days | Dates (provisional) | Work | Exit check |
| --- | --- | --- | --- |
| 1–7 | 10-12 → 10-18 | Extract the kit from `packages/mcp-server`: one command for account, rule, seller and first payment. Add CI job | S2 green |
| 8–12 | 10-19 → 10-23 | English guide, organised by role. Clean-machine dry run by one outside person | S1 |
| 13–16 | 10-24 → 10-27 | Turkish guide, workshop material, consent form, feedback form | S3 |
| 17–21 | 10-28 → 11-01 | Workshop, with the date agreed with the Chapter Lead | S4 |
| 22–27 | 11-02 → 11-07 | Fix what the workshop broke. Collect consented hashes | S5 |
| 28–30 | 11-08 → 11-10 | Sprint report: criteria met or not, evidence, feedback | S6, report |

## 11. Budget

The handbook gives no budget format and no hourly-rate guidance for Instawards. The only rule is "A scope that matches the requested award amount" (Rules §5). The team is one person.

| Line | Person | Hours |
| --- | --- | --- |
| Kit: extract, one-command setup, CI job | Barbaros | 30 |
| English guide, by role | Barbaros | 16 |
| Turkish guide | Barbaros | 8 |
| Workshop material and dry run | Barbaros | 10 |
| Workshop delivery and on-site support | Barbaros | 6 |
| Consent and usage collection, external-usage table | Barbaros | 6 |
| Fixes after the workshop | Barbaros | 10 |
| Sprint report | Barbaros | 6 |
| **Total** | | **92** |

- **Non-labour costs:** $0 on chain, because everything runs on Testnet and is funded by Friendbot. Venue: [BARBAROS: confirm the chapter provides one; otherwise add a line].
- **Ask:** [BARBAROS: set the amount, within $1,000–$5,000]. A $5,000 ask for 92 hours works out to ≈ $54/hour. State your rate and make the arithmetic add up.

## 12. Risks and single points of failure

- **One-person team.** If I stop, the project stops. There is no second maintainer and no second key-holder. Mitigations:
  - everything is in a public, Apache-2.0 repo;
  - every deployment can be reproduced from [DEPLOYMENTS.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/DEPLOYMENTS.md).
- **Unaudited contracts.** None of Barkeep's contracts is audited. The OpenZeppelin audits cover the `stellar-accounts` library at v0.7.0-rc.1, four tags behind the 0.7.2 that Barkeep uses ([ARCHITECTURE-v2.md §4.1](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/ARCHITECTURE-v2.md), [finding 03](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/findings/03-what-audited-covers.md)). The sprint stays on Testnet for this reason.
- **Known property gap in the deployed account.** Under 0.7.2 the auth digest is not scoped to the account. A cross-account replay was accepted on Testnet ([tx 512dbcbf…](https://stellar.expert/explorer/testnet/tx/512dbcbfa209f5fe92d36542500417c1ec9d23d9ad87cbfb375941c7a25b2be4)) and refused on v0.9.0 ([tx dbeb6f62…](https://stellar.expert/explorer/testnet/tx/dbeb6f62c96e00fb684be29ca6d5ea6e01993ef8ca4e9e15210987be427f0cdf)). The plan is to migrate when 0.9.0 publishes ([ARCHITECTURE-v2.md §10 risk 13](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/ARCHITECTURE-v2.md)).
- **Upstream dependency.** Stock x402 does not yet accept smart-account payers. The workshop uses Barkeep's facilitator fork and says so. Merges are in maintainers' hands and are not a success criterion.
- **Key management on Stellar Testnet.** Keys are generated with `stellar keys generate` and kept in the Stellar CLI's own store, outside the repo. No secret is in the repo. Keys are read at launch by a wrapper, so the MCP registration holds only a path ([DEPLOYMENTS.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/DEPLOYMENTS.md)). A lost Testnet key is replaced and the contracts redeployed. There is no documented rotation schedule.
- **Key management on Arc mainnet** (the only real-funds record):
  - **Generation.** The owner key was freshly generated right before funding, and checked on chain first (nonce 0, balance 0).
  - **Unused keys.** Keys generated on 2026-09-21 and 2026-09-23 were destroyed unused when exchange withdrawals were delayed.
  - **Agent key.** `close_tab` destroyed the agent key by overwriting and then removing its file ([MAINNET.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/MAINNET.md)).
  - **Gap.** The record does not say whether the mainnet owner key and the demo seller key were destroyed.
  - **Past loss.** On 2026-09-21 a machine was wiped before its keys were copied, and the Arc **Testnet** keys were lost with no backup. That is a real single-point-of-failure incident, disclosed in barkeep-arc `docs/TESTNET.md`.
- **Regulatory.** The Arc repo states it is "not a payment service in Türkiye". This sprint handles no real funds.

## 13. AI-assisted development

- **How it was used.** Much of this repository was written with an AI coding assistant (Claude Code, Anthropic models).
  - 47 of 62 commits carry a `Co-Authored-By: Claude …` trailer. I counted them with `git log` on 2026-09-25.
  - The findings and several docs open with a note that they are drafts written by Claude for my review.
  - The three upstream posts each carry an AI-assistance disclosure ([example](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326)).
  - This application draft was also prepared with Claude Code.
- **How quality is enforced (what exists):**
  - CI on every PR: `cargo test --workspace`, lint, typecheck, build and offline unit tests ([ci.yml](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/.github/workflows/ci.yml)).
  - A licence gate that fails the build on a disallowed dependency licence.
  - Every on-chain claim is a Testnet run whose hashes are recorded in `deployments/*.json`, and every refusal is forced on chain rather than only simulated.
  - The findings record where I was wrong, and where AI-written work passed its test yet did not work ([finding 06](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/findings/06-webauthn-verifier-sig-data-not-xdr.md), [finding 03](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/findings/03-what-audited-covers.md)).
  - On Arc, CI adds a mutation check (25 of 25 security rules caught, as its README states), Slither and a secret scan.
- **What is missing.** This Stellar repo has no mutation testing, no fuzzing and no external review.
- [BARBAROS: say in your own words what you personally check before merging, and which parts you wrote or re-derived yourself. The repo does not record this, so this draft does not claim it.]

## 14. After the sprint

[BARBAROS: your call. Nothing in the repo supports a revenue claim, so this draft makes none.]

Options to consider stating, each with a clear "not yet" where it applies:
- A follow-on Instaward for Option A (the upstream path, [Appendix D](#appendix-d-the-two-scope-options)).
- A Build Award later, if S5 produces real external usage.
- Any revenue model, such as a hosted facilitator, a fee on a hosted bill, or paid support. **There is none today.** If you list one, give it as a hypothesis with a test and a date after the grant window, not as a forecast.

---

# Working appendices (remove before sending)

## Appendix A: The official Instaward rules, with sources

Sources: the [SCF Handbook: Instawards](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards) and the [Instawards Official Rules](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules). The handbook source is [stellar/scf-handbook](https://github.com/stellar/scf-handbook); the Instawards pages were last changed 2026-07-23. All read 2026-09-25.

| Item | What SDF states | Source |
| --- | --- | --- |
| Amount | "initial Instaward in the range of $1,000 – $5,000 USD, paid in XLM". Follow-on awards bring the total "up to $15,000 … in the aggregate … or up to two (2) follow-on disbursements" | Rules §6 |
| Tier amounts | "issued in predefined tiers". The tiers themselves are **not stated** | Rules §6 |
| Payment schedule | "in accordance with the mutually agreed project plan". Tranche percentages are **not stated** | Rules §7 |
| XLM rate | CF "XLMUSD_RR" on the payment day | Rules §7 |
| How to apply | "no standard open application process", opened through Ambassador Chapter leads | Rules §1 |
| Eligibility | Active chapter participation; building on Stellar; a defined short-term scope; seeking early execution support | Rules §2, §4 |
| Age and sanctions | 18 or older; not in OFAC-sanctioned regions | [General Official Rules](https://stellar.gitbook.io/scf-handbook/scf-awards/official-rules-for-submissions) |
| Form fields, order, character limits | **Not stated anywhere public.** The only required item named is the Chapter Lead | Rules §7 |
| Scope | 30 days or less. "Strong scopes" contain a concrete deliverable, relevance to Stellar, clear success criteria, and an amount that matches the scope. Not funded: "vague exploration, unbounded research, or long-term roadmap funding" | Rules §3, §5, §6 |
| Review | "typically within 3-5 business days". "only SDF may approve". Chapter Leads' input is "non-binding" | Rules §3, §7 |
| KYC | Required before any payment | Rules §7 |
| Reporting | "structured sprint check-ins and end-of-sprint reviews against agreed success criteria" | Rules §9 |
| Follow-on awards | Not automatic. Needs a completed sprint confirmed by the Chapter Lead | Rules §8 |
| AI disclosure | **Not stated for Instawards.** The Open Track asks for "Full-disclosure on the use of AI-generated and AI-assisted artifacts" | [open-track](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/open-track) |
| Budget format | **Not stated** | — |
| Mainnet | **Not required.** Example scopes include "Building and deploying a first MVP on Stellar" | Rules §5 |
| Open source | **Not required.** Given as an example scope only | Rules §5 |
| Hackathons | **Not stated.** No official page ties Instawards to hackathons | — |
| Relation to the Build Award | Open Track and RFP Track: "Builders without much prior experience in domain or the Stellar ecosystem → Better fit for Instawards" | [open-track](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/open-track), [rfp-track](https://stellar.gitbook.io/scf-handbook/scf-awards/build-award/rfp-track) |

## Appendix B: Evidence audit

Kind of evidence:
- **T-TN**: team-generated, Stellar Testnet.
- **T-ARC**: team-generated, Arc mainnet.
- **EXT**: independent third party.
- **CODE**: code or tests in the repo.
- **—**: no proof, so the claim cannot be made.

| # | Claim | Proof | Kind | Can claim? |
| --- | --- | --- | --- | --- |
| 1 | The spending cap is enforced on chain | overCap [6f001e4a…](https://stellar.expert/explorer/testnet/tx/6f001e4a2266bedf8b016e4fde5a978cc4ae06a5f22a79545fe67d7b51ca0f47) `#3221` | T-TN | Yes, as Testnet |
| 2 | The tab expires on chain | afterExpiry [b253a6f8…](https://stellar.expert/explorer/testnet/tx/b253a6f86e311cc5704d83b7a507bc099d688513f398547614fb9cc40295be46) `#3002` | T-TN | Yes |
| 3 | `close_tab` revokes the agent key | [afda2b58…](https://stellar.expert/explorer/testnet/tx/afda2b58582ea1fc8a88a4cd1d6b3f037d04f2083aa1c959d84334497041e877) `#3000` | T-TN | Yes |
| 4 | The payee allowlist is enforced on chain | A2 [681ae9ea…](https://stellar.expert/explorer/testnet/tx/681ae9eae8d09c83f49b8977755687deae564458c4680589d9f88e0ab4a7b4d0) `#3901`; 19 cargo tests | T-TN, CODE | Yes |
| 5 | The allowlist and the cap compose | A2b [a66b26c6…](https://stellar.expert/explorer/testnet/tx/a66b26c6ef6932de6e81f9bf2b23f47d7631c1c3c95ef55ce4bd7c5c23bef505) `#3221` | T-TN | Yes |
| 6 | The agent cannot add a payee; the human can | [ff51d3a1…](https://stellar.expert/explorer/testnet/tx/ff51d3a16cef73ef922a1d9f0d3537362a85e0f02dc4b4d6e6b2bb71ca571afc), [cdc7e1db…](https://stellar.expert/explorer/testnet/tx/cdc7e1db7a8f2d385cb37feb2abed7c6723c6869b6b9c688fc281c91873f011b) | T-TN | Yes |
| 7 | An empty allowlist is refused | [b195c7ff…](https://stellar.expert/explorer/testnet/tx/b195c7ff78737ad4a4c5ec933ac613d532057aa91e5c52ecc18aa2d009e4a0b6) `#3902` | T-TN | Yes |
| 8 | An agent pays an x402 seller from a tab | P1 [18baa88e…](https://stellar.expert/explorer/testnet/tx/18baa88eedf273de301ef7e64b9f3192f186a8c6c36595e72662280d2b565fcb) | T-TN | Yes, **only through Barkeep's own facilitator** |
| 9 | Identical calls pay once | `doneTests.payAndFetch.P3`, `pay.test.ts` | T-TN, CODE | Yes |
| 10 | End-to-end MCP demo | demoStack, 2026-09-14 ([7f0ec6c1…](https://stellar.expert/explorer/testnet/tx/7f0ec6c1b882a5af712bab10771afad45ea02b58c3ec207829307267ea13d573)) | T-TN | Yes |
| 11 | The human signer is a passkey | [f6a66a60…](https://stellar.expert/explorer/testnet/tx/f6a66a603e160bb63e539b458acec6b6245f930d54ac8dc2918108397999ce17) | T-TN | Yes |
| 12 | The public x402 facilitator refuses capped smart accounts | x402Spike T2/T3; control T0 [8cdcd81b…](https://stellar.expert/explorer/testnet/tx/8cdcd81b9e30905fe175f8d1d827906031893cadc1964a2c11881be428a108e6) | T-TN | Yes |
| 13 | It settles with 2 checks relaxed | T4 [c02f9035…](https://stellar.expert/explorer/testnet/tx/c02f9035c0eb0250a619633c192aca4e43996a89dad927f7236f7508aab64aaf) | T-TN | Yes |
| 14 | The 0.7.2 digest is replayable across accounts; fixed on v0.9.0 | [512dbcbf…](https://stellar.expert/explorer/testnet/tx/512dbcbfa209f5fe92d36542500417c1ec9d23d9ad87cbfb375941c7a25b2be4) vs [dbeb6f62…](https://stellar.expert/explorer/testnet/tx/dbeb6f62c96e00fb684be29ca6d5ea6e01993ef8ca4e9e15210987be427f0cdf) | T-TN | Yes. Say it is a known upstream issue (#876, fixed by #868), not my discovery alone |
| 15 | Contract tests pass | `cargo test`: 70 passed, 6 ignored (local, 2026-09-25) | CODE | Yes |
| 16 | Unit tests pass | 132 passed (local); [CI run](https://github.com/barbarosalagoz/barkeep/actions/runs/35324655641) | CODE | Yes |
| 17 | Findings reported upstream | #897, #3515, [comment on #3352](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326) | Public record | Yes. Say "reported", not "accepted" or "fixed" |
| 18 | Upstream maintainers engaged | No maintainer reply on any item | — | **Cannot claim** |
| 19 | The same design ran with real funds | Arc mainnet hashes (§8) | T-ARC | Yes, **labelled Arc, not Stellar** |
| 20 | Circle's facilitator settled Barkeep-design payments | 3 settle hashes (§8) | T-ARC | Yes, as Circle's keyless trial, self-generated |
| 21 | Stellar mainnet deployment or flow | None. The repo is Testnet only | — | **Cannot claim** |
| 22 | External users, usage or partners | None | — | **Cannot claim** |
| 23 | Revenue or pricing | None | — | **Cannot claim** |
| 24 | Audited | Not audited | — | **Cannot claim.** Use the §4.1 wording |
| 25 | Website at barkeep.dev | On 2026-09-25 it serves a parked-domain page from the registrar | — | **Cannot claim.** Fix it or remove the link |
| 26 | Hackathon participation or result | Only "Hackathon prep" in PR #7 | — | **Cannot claim** until named with a link |
| 27 | Chapter participation | Nothing in the repo | — | **Cannot claim** until you supply it |
| 28 | Rise In Yellow Belt submitted | [YELLOW_BELT.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/YELLOW_BELT.md); the deployment answers HTTP 200 at promptrail-ten.vercel.app | CODE, T-TN | Submitted, yes. A pass or grade is not recorded, so it cannot be claimed |
| 29 | Mutation-tested | Arc only (its README states 25/25). Not in this repo | T-ARC (not verified by a run here) | Only for barkeep-arc, quoted from its README |
| 30 | A differentiator versus SDF's x402-MCP roadmap | The roadmap item is unshipped ([stellar.org/blog x402-on-stellar](https://stellar.org/blog/foundation-news/x402-on-stellar)) | — | Say it is a roadmap overlap. Do not claim "first" |

## Appendix C: Checklist pass

The feedback and referral criteria come from the two documents the user shared. They are paraphrased here.

| Item | Verdict | Evidence | What would close it |
| --- | --- | --- | --- |
| Independent third-party usage, separated from team metrics | **Not met** | Zero external usage (B-22). The labels are now separated in §8 | S5: consented attendee hashes from their own keys. Or one outside builder running the kit |
| Named launch partners | **Not met** | None | See GAPS #3. A written "yes, we'll try it" from one named builder or project |
| End-to-end mainnet flow with tx hashes | **Partly** | Arc mainnet: yes (T-ARC). Stellar mainnet: no | Either argue that Testnet is enough for an Instaward (the rules do not require mainnet), or run a tiny Stellar mainnet flow (GAPS #5) |
| One-sentence "why not the existing path" | **Partly** | Drafted in §6. It is not in your voice yet | Rewrite it |
| Explicit composition with x402 and Stellar agent-payment standards | **Partly** | x402 `exact` and OZ `stellar-accounts`: yes. It works only with Barkeep's facilitator fork. MPP: not integrated. OZ Relayer facilitator: not measured | Measure the OZ Relayer facilitator with a smart-account payer. Say plainly why MPP is deferred |
| A single narrow product | **Partly** | The README still carries PromptRail, the SEP ramp, the v0.9 twin and an Arc sibling | The application names one deliverable (§4). Trim the README so a reviewer lands on the tab |
| Line-by-line budget, reference ceiling ~$30k | **Met in the draft** (the rate is open) | §11, 92 h. The Instaward cap is $5k, not $30k | Set a rate. Check the arithmetic |
| Per-person hours | **Met in the draft** | §11 | — |
| AI-assisted development disclosed | **Partly** | Upstream posts disclose it; commit trailers; §13 drafted | Add a repo-level statement. Describe your own review practice |
| Load-bearing sections in the team's own voice | **Not met** | The repo's docs say they are Claude drafts. This draft is too | Rewrite §3, §4, §6 and the scope choice yourself |
| Competitive analysis beyond Stellar | **Met in the draft** | Appendix E, with sources | Check the rows marked unverified before quoting them |
| Revenue milestones beyond the grant window | **Not met** | None exist | Your decision. Nothing supports one today |
| Documented single points of failure (keys, custody) | **Partly** | DEPLOYMENTS.md; Arc MAINNET.md and TESTNET.md; §12 | Record the disposition of the Arc mainnet owner and seller keys. Add a Stellar key-lifecycle section (generate, store, rotate, destroy) |
| Verifiable evidence for every claim | **Mostly met** for technical claims | Appendix B | Remove barkeep.dev or make it live. Name the hackathon |
| *Referral:* fresh hackathon teams → Instawards | **Partly** | The handbook route is Ambassador Chapter participation, not hackathons. The hackathon is not named | Chapter engagement and a Chapter Lead (GAPS #1) |
| *Referral:* Open Track needs a novel angle and a verifiable team | **Partly / not yet** | The angle overlaps SDF's x402-MCP roadmap and Crossmint's claims. The team is one person, verifiable through GitHub history and upstream issues only | Not the target now. Revisit after S5 |
| *Referral:* x402 Facilitator/Bazaar RFP | **Not a fit** | Barkeep's facilitator is a test fork. Several SCF #45 facilitator candidates already exist | Do not apply |
| *Referral:* LayerZero DVN RFP | **Not eligible** | The RFP requires an "Existing DVN track record (hard prerequisite)" | Do not apply |

## Appendix D: The two scope options

### Option A: Smart-account payers on stock x402, plus a payee policy for OpenZeppelin accounts

- **Why it is needed.** A Stellar smart account that enforces a cap cannot pay through stock x402 today. It is blocked by #3158 (client), #3352 (event check) and #3515 (fee ceiling). Every builder with a capped agent hits this.
- **Why not the existing path (one sentence).** The existing path gives the agent a plain G-account key, because that is the only payer the stock x402 client and the public facilitator accept, so the spending cap cannot live on chain.
- **Composition.**
  - **x402:** upstream patches, so no fork is needed.
  - **OpenZeppelin:** `barkeep-payee-allowlist` packaged as a standalone policy crate for `stellar-accounts` that sits next to `spending_limit` on one context rule.
- **Honest constraint.** #3158 already has an open fix PR by someone else ([#3018](https://github.com/x402-foundation/x402/pull/3018)), and #3352 has one too ([#3399](https://github.com/x402-foundation/x402/pull/3399)). My part would be testing and reviewing those, plus writing the #3515 fix. No maintainer has replied to any of these, so a merge cannot be a success criterion.

| Task | Days | Acceptance test | Hours |
| --- | --- | --- | --- |
| Test PR #3018 against a capped and allowlisted OZ account on Testnet; post the results on the PR | 1–4 | Comment posted, with tx hashes | 12 |
| Test PR #3399 the same way; post the results | 5–6 | Comment posted, with tx hashes | 6 |
| PR for #3515: publish `maxTransactionFeeStroops` in `/supported` `extra`, or raise the default; with tests | 7–13 | PR open, its CI green, test proving a 324k-stroop payer passes | 20 |
| Standalone `payee-allowlist` policy crate, rebased onto the published `stellar-accounts` (0.9.0 if it is out) | 8–20 | `cargo test` green; composition tests with `spending_limit`; README | 30 |
| Offer the policy upstream as an OpenZeppelin issue | 21 | Issue link | 2 |
| Measure the OZ Relayer x402 facilitator with a smart-account payer | 14–18 | Testnet hashes or a refusal string, recorded | 8 |
| Barkeep client uses the stock scheme with `authorizeEntry` (pinned to #3018 if it is unmerged) | 22–26 | demo-stack re-run, hashes recorded | 10 |
| Report | 27–30 | Published | 6 |
| **Total** | | | **94** |

Non-labour cost: $0 (Testnet). A $5,000 ask works out to ≈ $53/hour.

### Option B: The tab starter kit and a Türkiye chapter workshop (recommended)

- **Why it is needed.** No one outside me has ever opened a tab. The main gap the panel names is independent usage.
- **Why not the existing path (one sentence).** See §6.
- **Composition.** The kit uses OZ `stellar-accounts` context rules with `spending_limit` plus Barkeep's allowlist, and x402 `exact` through `@x402/stellar`. It documents exactly which two facilitator checks the fork relaxes and links the upstream issues. It switches to the stock facilitator when those issues close.
- **Tasks, dates, acceptance tests and budget:** §9, §10, §11. The total is 92 hours.

### Recommendation: Option B

1. **It fits the Instaward rules.** The rules require active chapter participation (§2, §4) and fund "early execution support". A chapter workshop is chapter participation and a deliverable at the same time. Option A's work happens in upstream repos and does not involve the chapter.
2. **It closes the largest gap.** Independent usage is currently zero. S5 produces the first external tx hashes, with consent, kept separate from mine. Option A produces more of my own Testnet hashes.
3. **Its success does not depend on people who are not responding.** Every Option B criterion is in my hands, the attendees' hands and the Chapter Lead's. Option A's value depends on maintainers who have not replied to #3018 (open since 2026-08-01), #3399, #3515 or #897.
4. **It does not duplicate someone else's fix.** "Fix #3158 upstream" is already written as PR #3018.

**What would change this.**
- If the Chapter Lead cannot host a workshop within the 30 days, B loses its core, and A becomes the better scope.
- If an x402 maintainer engages on #3018 or #3515 before you submit, A becomes much stronger.
- A is also the natural follow-on Instaward after B.

## Appendix E: Competitive analysis

All rows are from vendor docs or press releases read on 2026-09-25. "Unverified" means the source did not say.

**Beyond Stellar**

| Product | Where the limit is enforced | Chains | Source |
| --- | --- | --- | --- |
| Circle Agent Wallets | Off chain, in Circle's MPC: transfer limits, recipient allowlists, sanctions screening | Circle-supported chains | [docs](https://developers.circle.com/agent-stack/agent-wallets), [press](https://www.circle.com/pressroom/circle-launches-ai-infrastructure-to-power-the-agentic-economy) |
| Circle Gateway Nanopayments | Payment rail (batched EIP-3009), not a policy layer. Works with x402 | 11 EVM chains, no Stellar | [blog](https://www.circle.com/blog/nanopayments-powered-by-circle-gateway-is-now-live-on-mainnet) |
| Coinbase CDP Server Wallets v2, Policy Engine | Off chain, in a TEE. Per-request rules; a cumulative-spend rule is unverified | EVM, Solana | [policies](https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/policies/overview) |
| Coinbase Agentic Wallets / x402 `SpendControls` | Session and per-transaction caps. `SpendControls` looks like SDK-side accounting (my inference) | Base, EVM | [docs](https://docs.cdp.coinbase.com/agentic-wallet/welcome), [SpendControls](https://docs.cdp.coinbase.com/sdks/cdp-sdks-v2/typescript/x402/type-aliases/SpendControls.md) |
| Coinbase Spend Permissions | **On chain** (`SpendPermissionManager`): recurring per-period allowance; **no payee restriction** | EVM chains | [repo](https://github.com/coinbase/spend-permissions), [docs](https://docs.base.org/base-account/improve-ux/spend-permissions) |
| Safe Allowance Module | **On chain**: per-token allowance for a delegate, with an AI-agent quickstart | EVM | [docs](https://docs.safe.global/home/ai-agent-quickstarts/agent-with-spending-limit) |
| Zodiac Roles Modifier | **On chain**: roles, parameter conditions, refilling allowances | EVM | [docs](https://docs.roles.gnosisguild.org/general/allowances) |
| MetaMask Advanced Permissions (ERC-7715/7710) | **On chain**: caveat enforcers, e.g. "10 USDC per day" | EVM | [docs](https://docs.metamask.io/smart-accounts-kit/concepts/advanced-permissions/) |
| ZeroDev session keys, Biconomy Smart Sessions | **On chain**: call, rate, time and fund policies | EVM | [ZeroDev](https://docs.zerodev.app/sdk/permissions/intro), [Biconomy](https://docs.biconomy.io/new/smart-sessions/introduction) |
| Crossmint Agent Wallets | Claims on-chain limits and allowlists; agent key in a TEE. **Lists Stellar**; its Stellar mechanism is unverified | EVM, Solana, Stellar | [compare](https://www.crossmint.com/learn/agent-wallets-compared) |
| Privy, Turnkey | Off chain, in an enclave policy engine | Multi-chain | [Privy](https://docs.privy.io/security/wallet-infrastructure/policy-and-controls), [Turnkey](https://docs.turnkey.com/features/policies/overview) |
| Lit Protocol Vincent | Policy checked by the Lit network before a threshold signature; current status unverified | EVM | [repo](https://github.com/LIT-Protocol/Vincent) |
| Stripe Shared Payment Tokens | Off chain: a token scoped to a seller, with a max amount and expiry (preview) | Card and bank | [docs](https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens) |
| Visa Intelligent Commerce, Mastercard Agent Pay | At the card network: agent tokens | Card | [Visa](https://developer.visa.com/capabilities/visa-intelligent-commerce), [Mastercard](https://www.mastercard.com/global/en/news-and-trends/press/2025/april/mastercard-unveils-agent-pay-pioneering-agentic-payments-technology-to-power-commerce-in-the-age-of-ai.html) |
| Google AP2 | Protocol: signed mandates. Does not enforce anything itself | Agnostic | [spec](https://ap2-protocol.org/) |

**Stellar**

| Project | Relation to Barkeep | Source |
| --- | --- | --- |
| OpenZeppelin `stellar-contracts` smart accounts | The base Barkeep builds on. Ships `spending_limit`, no payee policy | [docs](https://docs.openzeppelin.com/stellar-contracts/accounts/smart-account) |
| `stellar/smart-account-kit` | TypeScript SDK for OZ accounts. Labelled "Unaudited integration software" | [repo](https://github.com/stellar/smart-account-kit) |
| `stellar/passkey-kit` | Earlier passkey smart-wallet SDK | [repo](https://github.com/stellar/passkey-kit) |
| SDF x402 on Stellar | Roadmap item: an **x402-MCP server** where agents pay "via smart wallets… within user-defined spending policies". This is the **closest overlap**. Not shipped, as far as checked | [blog](https://stellar.org/blog/foundation-news/x402-on-stellar) |
| OpenZeppelin Relayer x402 facilitator | Testnet and mainnet facilitator. Whether it accepts a smart-account payer is unmeasured | [guide](https://docs.openzeppelin.com/relayer/guides/stellar-x402-facilitator-guide) |
| MPP on Stellar | Charge and session payments, no facilitator. No account-level policy in its docs | [docs](https://developers.stellar.org/docs/build/agentic-payments/mpp) |
| SCF #45 facilitator and Bazaar projects (e.g. Vellar, AgentSmith, Rail402) | Facilitators, not payer-side policies. Vellar's author filed #3158 | [SCF projects](https://communityfund.stellar.org/projects), [vellar-facilitator](https://github.com/Vellar-Wallet/vellar-facilitator) |

**What this means for the pitch.**
- On chain, payee-limited caps already exist on EVM: Zodiac, ZeroDev, MetaMask. Barkeep is not a new idea in general.
- The narrow claim that holds is this: on Stellar, with OpenZeppelin accounts, paying through x402, the pieces do not work together today, and Barkeep documents and works around exactly where they break.
- Do not claim "first". SDF's own roadmap names the same outcome.
