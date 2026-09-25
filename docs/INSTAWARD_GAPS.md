# Instaward: what only you can do before sending

Prepared 2026-09-25 alongside [INSTAWARD_APPLICATION.md](INSTAWARD_APPLICATION.md). The items are ordered by impact. The first three decide whether there is an application at all.

## 1. Get a Chapter Lead, and be able to show chapter participation

**Why this comes first:** there is no open form. According to the rules, Instawards "don't have a standard open application process". Opportunities come through Ambassador Chapter leads, and the submission must "identify the Chapter Lead who assists with the submission" ([Official Rules §1, §7](https://stellar.gitbook.io/scf-handbook/scf-awards/instawards/official-rules)). Eligibility also requires "actively participating in a local Stellar Ambassador Chapter", which is more than "joining a Discord or attending a single event" (§2, §4).

**What to do:**
- Contact the Türkiye chapter. Its [page](https://stellar.gitbook.io/ambassador-program/chapters/europe-and-middle-east/turkiye-chapter) lists İrem Koçi (Rise In) as Chapter Lead.
- Ask them for:
  - the actual form, including its fields and any tier amounts;
  - whether Barkeep fits;
  - whether the chapter can host a workshop inside the 30-day sprint (Option B depends on this);
  - what counts as participation for you.
- Write down your chapter activity with dates and links: meetups, demos, the Rise In belts. It goes in §2 of the application.
- Name the hackathon: its name, date, organiser, your result, and a link. The repo only says "Hackathon prep" (PR #7).

## 2. Rewrite the load-bearing sections yourself

The SCF panel feedback asks for these in the team's own voice. The repo's own docs say they are Claude drafts, and so is this application. Rewrite these from the bullet notes:
- §3 Problem
- §4 Deliverable and scope choice
- §6 Why this approach, including the one-sentence "why not the existing path"
- §13 The last bullet: what you personally review before merging
- §14 After the sprint

If a reviewer asks you about any of these on a call, your answer should match what is written.

## 3. Line up one named outside person or project

Independent usage is **zero** today, and the panel names this first. Even with Option B, a named early user strengthens the application. The people below are publicly working on exactly the problem Barkeep works around. They are candidates to approach, not endorsements:

| Who | Why them | Public link |
| --- | --- | --- |
| davedumto (Vellar-Wallet) | Filed #3158; runs a Stellar x402 facilitator (an SCF #45 candidate) | [#3158](https://github.com/x402-foundation/x402/issues/3158), [vellar-facilitator](https://github.com/Vellar-Wallet/vellar-facilitator) |
| tolgayayci | Wrote the fix PR for #3158 and verified it on Testnet | [#3018](https://github.com/x402-foundation/x402/pull/3018) |
| theboycoder | Filed #3352 for the same spend-capped smart-account case | [#3352](https://github.com/x402-foundation/x402/issues/3352) |
| skyc1e | Wrote the fix PR for #3352 | [#3399](https://github.com/x402-foundation/x402/pull/3399) |
| OpenZeppelin Relayer x402 plugin maintainers | Their facilitator is the likely mainnet path; nobody has measured a smart-account payer on it | [plugin](https://github.com/OpenZeppelin/relayer-plugin-x402-facilitator) |

**What to ask:** "Would you run the kit, or point your facilitator at a capped tab, and let me cite the result?" Cite only what they agree to in writing. List them as partners only if they say so.

## 4. Fix or remove barkeep.dev

The README says "Home: **barkeep.dev**". On 2026-09-25 that URL served a registrar's parked-domain page. A reviewer who clicks it lands on a parking page. Either put up a one-page site that links the repo and the evidence, or remove the link from the README and the application.

## 5. Decide on a Stellar mainnet flow (optional)

**What the rules say:** Instawards do not require mainnet (Rules §5). The panel feedback does ask for "an end-to-end mainnet flow with tx hashes". The Arc run answers that for another chain only.

**Arguments against running one now:**
- [ARCHITECTURE-v2.md](ARCHITECTURE-v2.md) says mainnet is "closed until the policy review" (constraint 4, §10 risk 2). Every contract is unaudited.
- The deployed 0.7.2 account has the auth-digest gap (§10 risk 13).
- The public facilitator lists `stellar:testnet` only. A mainnet run needs your own facilitator, or the OZ Relayer one (untested with a smart-account payer).
- The Arc repo states it is "not a payment service in Türkiye". Running a mainnet payment service is a separate question from running a single self-funded test.

**If you do it anyway:** copy the Arc discipline.
- A fresh owner key, generated only when funds are ready, and read on chain first.
- A cap of a few cents.
- Refusals forced on chain.
- Close, then sweep.
- Record every hash.
- Record what happened to **every** key.
- Label all of it **[TEAM · STELLAR MAINNET]**.

## 6. Close the key-management record

- **Arc:** `docs/MAINNET.md` does not say whether the mainnet **owner** key and **demo seller** key were destroyed or kept, and both addresses still hold dust. Add one line for each key, saying where it is now.
- **Stellar:** [DEPLOYMENTS.md](DEPLOYMENTS.md) covers generation and storage. Add rotation (currently none) and destruction (currently none, because Testnet keys are throwaway). One honest sentence each is enough.
- **Single point of failure:** the 2026-09-21 Arc Testnet key loss (barkeep-arc `docs/TESTNET.md`) is a real single-point-of-failure event. Keep it disclosed. Say what you changed afterwards, for example backups or where state lives.

## 7. Add a repo-level AI-assisted development statement

The upstream posts disclose AI use, but the repo has no single statement. Add a short section to the README. Base it on §13 of the application, and add your own account of what you check.

While you are there, consider adding mutation testing to this repo. For example, `cargo-mutants` on `barkeep-payee-allowlist`, so that the Stellar repo matches the Arc repo's 25/25 check. At the moment the Stellar side has none.

## 8. Set the amount and your rate

The first award is $1,000–$5,000, paid in XLM. The options are 92 or 94 hours. A $5,000 ask works out to about $53–54 per hour. Choose your own rate and make the arithmetic in §11 add up. The ~$30k reference ceiling in the panel feedback is for a larger programme and does not apply to this one.

## 9. Narrow what a reviewer sees

The README still opens with PromptRail history, the SEP ramp, the v0.9 twin deployment and a pointer to the Arc sibling. Before sending, make sure the first screen of the README is the tab, its evidence, and the one sprint deliverable. You can also close or finish the stale open [PR #2](https://github.com/barbarosalagoz/barkeep/pull/2) (Orange Belt, open since 2026-08-28).

## 10. Decide what you will say about after the sprint

Nothing in the record supports a revenue milestone. You have three choices:
- say nothing;
- say "follow-on Instaward for Option A";
- state a revenue hypothesis with a test and a date after the grant window.

Do not state a forecast.

## 11. Before sending, double-check the rows marked "unverified"

In Appendix E, several competitor details could not be confirmed from primary sources:
- Crossmint's mechanism on Stellar;
- whether the CDP Policy Engine has a cumulative-spend rule;
- Lit Vincent's current status;
- whether SDF's x402-MCP has shipped.

Re-check any row you quote. In particular, if SDF's x402-MCP has shipped, the "why not the existing path" answer has to address it directly.

## 12. KYC and eligibility basics

- You must be 18 or older and not in an OFAC-sanctioned region.
- KYC must be completed before any payment.
- An individual "may not join more than one Team" ([General Rules](https://stellar.gitbook.io/scf-handbook/scf-awards/official-rules-for-submissions)). If barkeep-arc or any other project is also applying to SCF, check this rule first.
