# Instaward working notes (internal, not for sending)

These notes sit behind [INSTAWARD_APPLICATION.md](INSTAWARD_APPLICATION.md):
the official rules with their sources, the claim-by-claim evidence audit, the
checklist pass, and the two scope options. Option B was chosen on 2026-09-25.
What is still open before sending is in [INSTAWARD_GAPS.md](INSTAWARD_GAPS.md).

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
| 16 | Unit tests pass | 143 passed (local, 2026-09-25, after per-tab keys); [CI run](https://github.com/barbarosalagoz/barkeep/actions/runs/35324655641) | CODE | Yes |
| 17 | Findings reported upstream | #897, #3515, [comment on #3352](https://github.com/x402-foundation/x402/issues/3352#issuecomment-5727321326) | Public record | Yes. Say "reported", not "accepted" or "fixed" |
| 18 | Upstream maintainers engaged | No maintainer reply on any item | — | **Cannot claim** |
| 19 | The same design ran with real funds | Arc mainnet hashes (application, What exists today) | T-ARC | Yes, **labelled Arc, not Stellar** |
| 20 | Circle's facilitator settled Barkeep-design payments | 3 settle hashes (application, What exists today) | T-ARC | Yes, as Circle's keyless trial, self-generated |
| 21 | Stellar mainnet deployment or flow | None. The repo is Testnet only | — | **Cannot claim** |
| 22 | External users, usage or partners | None | — | **Cannot claim** |
| 23 | Revenue or pricing | None | — | **Cannot claim** |
| 24 | Audited | Not audited | — | **Cannot claim.** Use the ARCHITECTURE-v2.md §4.1 wording |
| 25 | Website at barkeep.dev | On 2026-09-25 it served a parked-domain page from the registrar. Every link was replaced by the GitHub repo in PR #12 | — | **Cannot claim** until it serves a real page |
| 26 | Hackathon participation or result | Only "Hackathon prep" in PR #7 | — | **Cannot claim** until named with a link |
| 27 | Chapter participation | Nothing in the repo | — | **Cannot claim** until you supply it |
| 28 | Rise In Yellow Belt submitted | [YELLOW_BELT.md](https://github.com/barbarosalagoz/barkeep/blob/ef0dc73/docs/YELLOW_BELT.md); the deployment answers HTTP 200 at promptrail-ten.vercel.app | CODE, T-TN | Submitted, yes. A pass or grade is not recorded, so it cannot be claimed |
| 29 | Mutation-tested | Arc only (its README states 25/25). Not in this repo | T-ARC (not verified by a run here) | Only for barkeep-arc, quoted from its README |
| 30 | A differentiator versus SDF's x402-MCP roadmap | The roadmap item is unshipped ([stellar.org/blog x402-on-stellar](https://stellar.org/blog/foundation-news/x402-on-stellar)) | — | Say it is a roadmap overlap. Do not claim "first" |
| 31 | One session key per tab, destroyed on close | Commit `5d0b427`, `agentKeys.test.ts` (11 offline tests) | CODE | Only as "implemented and offline-tested". Testnet run pending (sprint S2) |
| 32 | Trainer for Rise In's first Stellar developer cohort | Nothing in the repo | — | Author's statement (application section 4). **Needs** a Rise In confirmation or link before it is sent |
| 33 | A per-call maximum enforced on chain | Arc: yes (reverts). Stellar: no, `max_amount` is enforced by the MCP server | T-ARC | Only for Arc. The application states the Stellar difference under section 2 |
| 34 | Arc mainnet keys destroyed after the run | Step 8 on 2026-09-24: shredded; a full disk search found no copies. The plan is in [barkeep-arc#9](https://github.com/barbarosalagoz/barkeep-arc/pull/9); the record is in [barkeep-arc#11](https://github.com/barbarosalagoz/barkeep-arc/pull/11). On the machine, `keys.json` is gone and the agent-key directory is empty | T-ARC, author's record | Yes |

## Appendix C: Checklist pass (updated 2026-09-25, after Option B was chosen)

| Item | Verdict | Evidence | What would close it |
| --- | --- | --- | --- |
| Independent third-party usage, separated from team metrics | **Not met** (by design, until the workshop) | Zero external usage. [EXTERNAL_USAGE.md](EXTERNAL_USAGE.md) is empty and kept apart from `deployments/*.json` | S5: at least 10 developers' consented hashes |
| Named launch partners | **Not met** | None | Optional. See [INSTAWARD_GAPS.md](INSTAWARD_GAPS.md) #3 |
| End-to-end mainnet flow with tx hashes | **Partly** | Arc mainnet: yes. Stellar mainnet: no, deliberately (unaudited; the rules do not require mainnet) | Stated plainly in the application |
| One-sentence "why not the existing path" | **Met** | Application, "Why not the existing path". It is AI-drafted and disclosed as such | — |
| Explicit composition with x402 and Stellar agent-payment standards | **Partly** | x402 `exact` and OZ `stellar-accounts`: yes, through a facilitator fork. MPP is deferred. The OZ Relayer facilitator has not been measured | A follow-on scope |
| A single narrow product | **Met** | The README leads with the tab; the rest is under History | — |
| Line-by-line budget | **Met** | 92 h, 8 lines. The amount is a chapter tier | Chapter confirms the tier |
| Per-person hours | **Met** | One person, 92 h | — |
| AI-assisted development disclosed | **Met** | [AI_ASSISTED_DEVELOPMENT.md](AI_ASSISTED_DEVELOPMENT.md), the application's section, the disclosure line | — |
| Load-bearing sections in the team's own voice | **Met for sections 1–5** | Sections 1–5 are the author's own text, translated with AI assistance, as disclosed. The one-sentence "why not the existing path" is still AI-drafted, and disclosed as such | Optional: the author rewrites that sentence |
| Competitive analysis beyond Stellar | **Met** | Application, "Competitive landscape", with sources | — |
| Revenue milestones beyond the grant window | **Not met** (stated honestly) | There is no revenue model, and the application says so | Only if one is decided later |
| Documented single points of failure (keys, custody) | **Met** | [KEY_MANAGEMENT.md](KEY_MANAGEMENT.md): Testnet and Arc lifecycles, the key loss, a single-point-of-failure table. Per-tab keys implemented | The Testnet run of per-tab keys (S2) |
| Verifiable evidence for every claim | **Met, with one exception** | Every technical claim links to a hash, a commit or a file. Section 4 (Rise In cohort) has no link yet | A Rise In confirmation (chapter field) |
| *Referral:* fresh hackathon team → Instawards | **Partly** | The official route is through chapter participation. The Chapter Lead field is open | Chapter fields |
| *Referral:* Open Track (novel angle, verifiable team) | **Not now** | Overlaps SDF's x402-MCP roadmap. Single-person team | After S5 |
| *Referral:* x402 Facilitator/Bazaar RFP | **Not a fit** | Barkeep's facilitator is a test fork | — |
| *Referral:* LayerZero DVN RFP | **Not eligible** | Needs an existing DVN (hard prerequisite) | — |

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
- **Why not the existing path (one sentence).** See the application, "Why not the existing path".
- **Composition.** The kit uses OZ `stellar-accounts` context rules with `spending_limit` plus Barkeep's allowlist, and x402 `exact` through `@x402/stellar`. It documents exactly which two facilitator checks the fork relaxes and links the upstream issues. It switches to the stock facilitator when those issues close.
- **Tasks, dates, acceptance tests and budget:** in the application. The total is 92 hours.

### Recommendation: Option B

1. **It fits the Instaward rules.** The rules require active chapter participation (Rules §2, §4) and fund "early execution support". A chapter workshop is chapter participation and a deliverable at the same time. Option A's work happens in upstream repos and does not involve the chapter.
2. **It closes the largest gap.** Independent usage is currently zero. S5 produces the first external tx hashes, with consent, kept separate from mine. Option A produces more of my own Testnet hashes.
3. **Its success does not depend on people who are not responding.** Every Option B criterion is in my hands, the attendees' hands and the Chapter Lead's. Option A's value depends on maintainers who have not replied to #3018 (open since 2026-08-01), #3399, #3515 or #897.
4. **It does not duplicate someone else's fix.** "Fix #3158 upstream" is already written as PR #3018.

**What would change this.**
- If the Chapter Lead cannot host a workshop within the 30 days, B loses its core, and A becomes the better scope.
- If an x402 maintainer engages on #3018 or #3515 before you submit, A becomes much stronger.
- A is also the natural follow-on Instaward after B.

