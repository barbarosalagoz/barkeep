# Submission Pack

Working notes and paste-ready text for the Stellar **Journey to Mastery** monthly
challenge submissions (Rise In). One section per belt.

> **Update 2026-09-12:** xBull was removed from the shipped wallet set for
> licensing reasons (its connector ships without a license; upstream is
> AGPL-3.0). The app now offers Freighter and Albedo, and the paste-ready
> submission text below says so. The dated verification records below still
> describe the app as it was verified on 2026-09-01.
>
> **Update 2026-09-12 (rename):** the project is now **Barkeep**
> (barkeep.dev). Everything below is left exactly as written and records what
> Rise In received under the old **PromptRail** name, including the deployment
> URL, which is unchanged and still live.

---

## Yellow Belt

Submitted for the September 2026 cycle (queue reset on 2026-08-31; nothing from
the prior cycle was reviewed).

### Verification snapshot — 2026-09-01

Everything below was re-verified against the tip of `main` on 2026-09-01:

| Check | Result |
| --- | --- |
| `main` == `origin/main` | ✅ both at the same commit |
| Contract resolves on stellar.expert | ✅ API returns creator `GDMLL4EV…` and wasm hash `06a0f8e8…` — both match the README |
| All 9 documented transactions | ✅ every tx hash returns `successful: true` on Horizon |
| Live contract state | ✅ `get_payment_count` = 4, `get_token` = native XLM SAC (via `scripts/verify-live.mjs`, RPC simulation, no wallet) |
| Live frontend (Vercel) | ✅ loads; wallet card shows detected/install badges; StellarWalletsKit modal opens with Freighter / Albedo / xBull |
| `npm run lint` / `npm run build` | ✅ clean / builds |
| Contract unit tests | ✅ 13 tests, run in CI (`cargo test --workspace`) |
| CI on tip | ✅ GitHub Actions run green on `main` (`.github/workflows/ci.yml`: cargo test + lint + build) |
| Commits on `main` | ✅ 28 (requirement: 12+) |

> Note: Soroban RPC's event-retention window has rolled past the Aug 28
> transactions, so the in-app **event feed** is empty until a fresh payment is
> made. Make one live payment before capturing tracker screenshots.

### Requirement checklist — requirement → implementation → evidence

Official Yellow Belt pillars (Rise In): *multi-wallet integrations, smart
contracts, transaction handling, real-time event synchronization* — plus the
four explicit points from the previous rejection.

| # | Requirement | Implementation | Evidence |
| --- | --- | --- | --- |
| 1 | Soroban smart contract (escrowed Payment Tracker) | `contracts/payment-tracker/src/lib.rs` — `initialize` L145, `create_payment` L165, `create_batch` L188, `complete_payment` L217, `cancel_payment` L222, reads L231–L257; `require_auth` L171/L193/L343 | Deployed contract `CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X` on Testnet; [stellar.expert contract page](https://stellar.expert/explorer/testnet/contract/CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X) |
| 2 | Contract deployed to Stellar Testnet + invoked on-chain | README "Verified on-chain activity" table | 9 confirmed txs, e.g. deploy [`9a75966a…`](https://stellar.expert/explorer/testnet/tx/9a75966a7c395228434f6774f0e831013cefaff474c2192dbd944660c2e143eb), `create_payment` [`d13babf0…`](https://stellar.expert/explorer/testnet/tx/d13babf0aefbad0edd6f2057a6b85f58b4d38dee3d26f3226091bfe833081c0d) — all re-checked `successful: true` on Horizon 2026-09-01 |
| 3 | Contract unit tests | `contracts/payment-tracker/src/test.rs` — 13 `#[test]` functions (L58–L308) | CI job `contract` runs `cargo test --workspace` on every push |
| 4 | Multi-wallet via StellarWalletsKit (rejection point) | `src/services/wallet.ts` — kit init with Freighter/Albedo modules L56, `authModal` L94, `signTransaction` L162 | Live modal on https://promptrail-ten.vercel.app/ (verified 2026-09-01); screenshot `docs/screenshots/wallet-options.png` |
| 5 | Transaction handling (build → sign in wallet → submit → confirm, hash + explorer link) | `src/App.tsx` payment flow L499–L550; `src/contract/paymentTracker.ts` typed client (prepare/sign/submit/poll) | Screenshots `payment-success.png`, `payment-error.png`, `balance-testnet.png`; on-chain txs in the README table |
| 6 | Real-time event synchronization (rejection point) | `src/contract/paymentTracker.ts` `fetchContractEvents` L464 (Soroban RPC `getEvents`); `src/components/PaymentTracker.tsx` 8s status polling L42/L180, event feed L118; typed `#[contractevent]`s in `lib.rs` L99–L127 | Feed visible in app after a fresh payment |
| 7 | Distinct error handling (wallet not found / rejected / insufficient balance) | `src/errors.ts` taxonomy L12–L68; banners in `PaymentTracker.tsx` L81–L83 and `App.tsx` L47–L51 | `payment-error.png`; Freighter "install ↗" badge on live page doubles as wallet-not-found detection |
| 8 | 12+ meaningful commits (rejection point) | — | 26 commits on `main` (`git rev-list --count main`) |
| 9 | Public repo + public deployment | — | https://github.com/barbarosalagoz/promptrail · https://promptrail-ten.vercel.app/ |
| 10 | White Belt carryover (connect/disconnect, balance, XLM send, feedback) | `src/App.tsx`, `src/services/wallet.ts` | `wallet-connected.png`, `balance-testnet.png`, `payment-success.png` |

**Known gaps (hard-evidence rule):**

- No screenshot of the **Payment Tracker panel** itself (live status list +
  event feed) — only White Belt-era screenshots exist. → user capture below.
- The Rise In *detailed* rubric sits behind login; this checklist maps to the
  public pillar list + the prior reviewer's explicit rejection points. If the
  logged-in form lists extra items, add them here.

### Submission text (paste into the Rise In form)

**Project summary**

> PromptRail — machine payments on Stellar. A Soroban escrow contract (Payment
> Tracker) deployed on Testnet holds XLM in flight and tracks Pending →
> Completed/Cancelled across single and multi-recipient batches, emitting a
> typed event on every state change. A React dApp drives it end-to-end through
> StellarWalletsKit (Freighter, Albedo): connect, balance, XLM payments,
> contract calls, live status polling, and a real-time contract event feed —
> no backend. Contract: `CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X`.

**What changed since the previous review**

> - **Soroban contract deployed to Testnet** — escrowed Payment Tracker
>   (create/complete/cancel + batches), deployed and invoked on-chain: 9
>   confirmed transactions documented with hashes in the README, verifiable on
>   stellar.expert and Horizon.
> - **Multi-wallet via StellarWalletsKit** — wallet-selection modal with
>   Freighter and Albedo; all signing (XLM payments and contract calls)
>   goes through the kit. Implementation: `src/services/wallet.ts`.
> - **Real-time events** — the contract emits typed `#[contractevent]`s; the
>   frontend consumes them via Soroban RPC `getEvents` plus 8-second live
>   status polling, shown in an in-app event feed.
> - **Commit history** — 28 meaningful commits on `main` (was flagged as too
>   few; requirement 12+), plus CI (cargo test + lint + build) on every push.

**Links**

> - Repo: https://github.com/barbarosalagoz/promptrail
> - Live app: https://promptrail-ten.vercel.app/
> - Contract: https://stellar.expert/explorer/testnet/contract/CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X

**How to test (3 steps)**

> 1. Open https://promptrail-ten.vercel.app/ with a Testnet wallet (Freighter
>    or Albedo; fund via Friendbot) and connect through the wallet modal.
> 2. In **Payment Tracker**, create an escrowed payment (or a multi-recipient
>    batch), sign in your wallet, and watch it appear as *Pending* with a
>    linked tx hash; then **Complete** or **Cancel** it and watch the status
>    and event feed update live.
> 3. No wallet? Verify the deployed contract directly:
>    `node scripts/verify-live.mjs` (reads live state via RPC simulation), or
>    open the stellar.expert contract page above.

### Only-you tasks

- [ ] **Screenshot:** Payment Tracker panel with a payment list + event feed
      (after one fresh payment) → save as
      `docs/screenshots/tracker-live.png`; it then gets referenced from the
      README and row 6 above.
- [ ] **Rise In form:** paste the blocks above into the matching fields;
      add any rubric items the logged-in form shows that this pack missed.

---

## Orange Belt

Most of the work already exists on the **`orange-belt` branch** — open
[PR #2](https://github.com/barbarosalagoz/promptrail/pull/2)
("Orange Belt: inter-contract payments, CI/CD, production dApp",
16 commits ahead of `main`). This section tracks what's built, what's
verified, and what's left before submitting.

### What the branch delivers (per PR #2, spot-verified 2026-09-01)

- **Inter-contract communication** — two new Soroban contracts:
  - `contracts/service-registry/` — on-chain service catalog
    (`register_service` / `update_service` / `deactivate_service`,
    `get_active_service` as the cross-call entry point, paginated
    `list_active`, typed errors + events). 12 unit tests.
  - `contracts/payment-router/` — `pay_for_service(payer, service_id)`
    cross-calls the registry through its generated client in one invocation:
    resolves price + payout, transfers XLM payer→provider, records a receipt,
    emits `service_paid`. 11 unit tests incl. 6 integration tests over the
    real cross-contract path.
  - Yellow Belt `payment-tracker` untouched.
- **Deployed to Testnet** (both verified on stellar.expert, same deployer
  `GDMLL4EV…ZDJY`, 2026-09-01):
  - service-registry: `CDPCOA6EGW5KN2TFOUZ2KS5ONSM3H44ZCMHTPBPM43VMJ5PTGWJ7JJSX`
  - payment-router: `CCQXYM6U5TVKWXI6HKEIQFBYYA7PHRDPMCZFV2NGRN4NRGQ2ELZP5YCX`
  - Real `pay_for_service` invocation confirmed on Horizon:
    [`04053f6f…`](https://stellar.expert/explorer/testnet/tx/04053f6f86d31c2a6ff98081fbc44bd8cf1eb9f8631b3bb64167a1e0243177b6)
- **CI/CD** — branch has its own `ci.yml` (fmt, clippy `-D warnings`, test /
  npm lint, test, build) and `deploy-contracts.yml` (workflow_dispatch wasm
  build; signing stays local in `scripts/deploy.sh`). A green run is
  captured in `docs/screenshots/ci-pipeline.png` (on the branch).
- **Frontend** — services marketplace (browse catalog, pay via router through
  the wallet kit, provider registration, live receipts), merged two-contract
  event feed, env-driven config, typed per-contract clients, mobile
  responsive. 18 Vitest tests; `docs/screenshots/test-output.png` (on the
  branch) shows all 36 contract + 18 frontend tests passing.
- **Docs** — Orange Belt README section with architecture diagram;
  `docs/DEMO_SCRIPT.md` = timed 90-second demo script for this marketplace UI.

### Remaining before submission

- [ ] Reconcile `main`'s `.github/workflows/ci.yml` (added 2026-09-01) with
      the branch's richer `ci.yml` — resolve the merge conflict in favor of
      the branch version.
- [ ] Merge PR #2 once the Yellow Belt review cycle no longer needs `main`
      frozen (merging changes the app the Yellow Belt links point to — decide
      timing deliberately).
- [ ] `mobile-ui.png` — manual capture (PR body lists it as missing).
- [ ] Record the 90-second demo video following `docs/DEMO_SCRIPT.md`.
- [ ] Re-run this pack's verification drill against the merged tip
      (contracts resolve, txs confirmed, CI green, fresh events for the feed).
- [ ] Copy the official Orange Belt rubric from the logged-in Rise In page
      and map it row-by-row like the Yellow Belt table above.

### Submission text

_Draft after merge, using the PR #2 body as the base._
