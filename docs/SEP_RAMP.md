# TRY on/off-ramp via SEP

Moved here from the repository README on 2026-09-14, unchanged except that
relative links now resolve from `docs/`. The ramp lives in `packages/web`
(`src/services/anchor/*`, `src/components/TryRamp.tsx`) and is neither part of
the tab nor of the Yellow Belt submission; it is the optional TRY top-up path
described in `ARCHITECTURE-v2.md` §3.

Barkeep can move between **Turkish Lira and USDC** through a Stellar
anchor using only the portable SEP path — the standard interface every real
anchor exposes. No partner API key, no anchor-specific endpoints. The whole
hand-off is two config values (a **home domain** and an **asset code**);
everything else is discovered at runtime.

| SEP | Role | Where |
| --- | --- | --- |
| SEP-1 | Discovery: read `https://<home-domain>/.well-known/stellar.toml` for the auth, transfer and quote servers, the signing key and the USDC issuer | [src/services/anchor/sep1.ts](../packages/web/src/services/anchor/sep1.ts) |
| SEP-10 | Login: verify the anchor's challenge, sign it with the connected wallet, receive a JWT | [src/services/anchor/sep10.ts](../packages/web/src/services/anchor/sep10.ts) |
| SEP-38 | Firm quotes (TRY ⇄ USDC) shown before any transfer; the quote id locks the rate | [src/services/anchor/sep38.ts](../packages/web/src/services/anchor/sep38.ts) |
| SEP-6 | Deposit (bank transfer in, USDC out) and withdraw (USDC in with memo, TRY out), status polling, history | [src/services/anchor/sep6.ts](../packages/web/src/services/anchor/sep6.ts) |
| Horizon | USDC trustline check/creation and the memo'd USDC payment that settles a withdrawal | [src/services/anchor/horizon.ts](../packages/web/src/services/anchor/horizon.ts) |

The flows are composed in [src/services/anchor/index.ts](../packages/web/src/services/anchor/index.ts)
and rendered by the **TRY ⇄ USDC via anchor** panel
([src/components/TryRamp.tsx](../packages/web/src/components/TryRamp.tsx)), which appears
under the Payment Tracker once a wallet is connected.

Development target: the [TR Mock Anchor](https://tr-mock-anchor.fly.dev)
(Stellar Testnet, sandbox — no real money moves).

## Deposit: TRY → USDC (on-ramp)

1. Enter a TRY amount and press **Get quote**. The first anchor call triggers
   a SEP-10 login: the wallet signs the anchor's challenge (after the app has
   verified it against the toml's `SIGNING_KEY`, home domain and
   `web_auth_domain`). The firm SEP-38 quote shows rate, fee, USDC out and a
   countdown.
2. Press **Start deposit**. If the wallet has no USDC trustline the app asks
   it to sign one, then opens the SEP-6 deposit (at the quoted rate when a
   quote is present).
3. The panel shows the anchor's **bank, IBAN and reference**. Send TRY with
   the reference in the transfer description. On the sandbox, press
   **Simulate the bank transfer** instead.
4. The app polls `GET /transaction` (`pending_user_transfer_start` →
   `pending_anchor` → `completed`), links the Stellar transaction and
   refreshes the USDC balance. A `pending_trust` status re-triggers the
   trustline step automatically.

## Withdraw: USDC → TRY (provider payout / off-ramp)

1. Enter a USDC amount and (optionally) get a quote.
2. Press **Withdraw**. The app opens the SEP-6 withdrawal, receives the
   anchor's Stellar account + memo, and asks the wallet to sign a USDC
   payment carrying that memo.
3. It polls until the anchor reports `completed` and shows the TRY paid, the
   bank reference and the Stellar transaction.

This is the payout path for an API provider that is paid in USDC on-chain and
wants TRY in the bank.

## Configuration (Testnet → Mainnet is a config change)

All network and anchor settings live in
[src/config/stellar.ts](../packages/web/src/config/stellar.ts) and are read from `VITE_*`
env vars (see [.env.example](../packages/web/.env.example)):

```bash
VITE_STELLAR_NETWORK=public                 # default: testnet
VITE_ANCHOR_HOME_DOMAIN=anchor.example.com  # default: tr-mock-anchor.fly.dev
VITE_ANCHOR_ASSET_CODE=USDC
VITE_ANCHOR_FIAT_CODE=TRY
```

The wallet gate, Horizon, explorer links and the network passphrase the
anchor's `stellar.toml` must match all follow `VITE_STELLAR_NETWORK`. The
sandbox "simulate bank transfer" helper is disabled on `public`. Nothing in
the SEP client names a URL or issuer directly.

## Tests

```bash
npm test
```

Runs the offline unit suite (toml validation, SEP-10 challenge checks,
response parsing, error mapping, memo building; CI runs these via
`npm run test:unit`) **and** the live suite
([src/services/anchor/anchor.live.test.ts](../packages/web/src/services/anchor/anchor.live.test.ts)),
which creates a Friendbot-funded Testnet key and drives SEP-1 → SEP-10 →
SEP-38 → SEP-6 deposit (with trustline creation) → SEP-6 withdraw against the
mock anchor, moving real Testnet USDC. Set `SEP_SKIP_LIVE=1` to skip the live
suite offline.

The offline suite also covers the build's license gate
([build/](../packages/web/build/)): the allow-list, copyright extraction, and fixture builds
that must fail for AGPL, unlicensed and private copyleft packages.

## Demo script

```bash
npm run demo:sep
```

[scripts/sep-demo.ts](../packages/web/scripts/sep-demo.ts) prints every step with
timestamps: discovery, login, quote, IBAN + reference, simulated bank leg,
status transitions, USDC credit, quote, memo'd USDC payment, TRY payout and
history. Use `SEP_DEMO_SECRET=S...` to reuse a Testnet key, and
`SEP_DEMO_TRY` / `SEP_DEMO_USDC` to change the amounts.

## Notes on the mock anchor

Observed while integrating (not yet reported; candidates to send to the anchor's maintainers at Rise In):

* `/llms-full.txt` documents the withdraw response as `memo_id`; the live
  endpoint returns the SEP-6 spec fields `memo` + `memo_type`. The client
  accepts both.
* `/llms-full.txt` lists deposit limits of 10–10,000, `/sep6/info` says
  0.5–300 (in USDC), and the deposit endpoint enforces 50–3,000 TRY. The app
  surfaces the endpoint's message rather than pre-checking limits.
* `/llms-full.txt` omits `pending_trust`, which the anchor does emit when the
  destination has no trustline; the client handles it.
* SEP-6 calls accept an `account` that differs from the JWT subject.

---
