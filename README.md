# Barkeep

**Open a tab for your AI agent.**

Barkeep is a Stellar dApp for machine payments. A human opens a tab with a
spending cap and a time window, an agent spends against it to pay for HTTP
requests, and every payment lands on an itemised bill.

Home: **[barkeep.dev](https://barkeep.dev)**

> **What ships today.** This repository currently holds the first technical
> foundation of that idea: a deployed Soroban **Payment Tracker** escrow
> contract and a multi-wallet React dApp that drives it end to end on Stellar
> Testnet. The tab-and-agent model described above is the v1 design, specified
> in [docs/ARCHITECTURE-v2.md](docs/ARCHITECTURE-v2.md). Part of it is now
> built and runs on Testnet: the MCP server in `packages/mcp-server`, which
> opens a tab, pays for HTTP requests against it, reports it and closes it --
> see [The tab (MCP server)](#the-tab-mcp-server-testnet), including what it
> **cannot** pay yet. The payee allowlist, the bill dashboard and plugin
> packaging are still a plan.
>
> The project was previously named **PromptRail**. Its Stellar Journey to
> Mastery — Yellow Belt submission record is preserved under the old name in
> [docs/YELLOW_BELT.md](docs/YELLOW_BELT.md).

It pairs a **deployed Soroban smart contract** with a React frontend that drives it end to end.

The on-chain half is a **Payment Tracker**: an escrow contract that holds XLM
while a payment is in flight and tracks its status across many recipients.

* Escrowed payments with a `Pending` / `Completed` / `Cancelled` lifecycle
* Multi-address batches — one payment per recipient in a single invocation
* Sender-authorized release and refund
* On-chain events for every state change

The off-chain half is a **multi-wallet dApp** built on
[StellarWalletsKit](https://stellarwalletskit.dev/):

* Connecting any supported Stellar wallet — **Freighter or Albedo** —
  through a wallet-selection modal
* Live payment status and a contract event feed that update in near-real-time
* Distinctly surfaced error handling (wallet not found, request rejected,
  insufficient balance)
* Detecting and validating the active Stellar network
* Fetching an account's XLM balance
* Building a Stellar payment transaction
* Signing the transaction securely in the user's chosen wallet
* Submitting the signed transaction to Stellar Testnet
* Displaying transaction success, failure, and transaction hash information

This contract and dApp are the first technical foundation for Barkeep's broader goal: programmable, machine-to-machine payments for APIs and AI agents on Stellar.

---

## Live Demo

Home: **[barkeep.dev](https://barkeep.dev)**

The current build is deployed at
[https://promptrail-ten.vercel.app/](https://promptrail-ten.vercel.app/). That
deployment URL is unchanged from the PromptRail era and stays live, because the
Yellow Belt submission links to it.

---

### Deployment Status

Barkeep is deployed publicly on Vercel and has been tested end-to-end on Stellar Testnet.

Verified production flow:

- ✅ Multi-wallet connection (Freighter / Albedo)
- ✅ Stellar Testnet detection
- ✅ XLM balance retrieval
- ✅ XLM transaction creation
- ✅ Wallet transaction signing
- ✅ Stellar Testnet submission
- ✅ Transaction confirmation
- ✅ Transaction hash and explorer link

---

## The tab (MCP server, Testnet)

`packages/mcp-server` is a local stdio MCP server for Claude Code. A tab is an
on-chain context rule on a smart account built on OpenZeppelin's
`stellar-accounts` library: the agent's session key as its only signer, a
spending-limit policy, and an expiry. The cap is enforced by that policy on
chain, not by the server. None of these contracts is audited; see
[docs/DEPLOYMENTS.md](docs/DEPLOYMENTS.md).

| Tool | What it does |
| --- | --- |
| `open_tab` | Adds the agent rule with a cap and a window |
| `pay_and_fetch` | Fetches a URL; on an x402 402 challenge, pays it from the tab |
| `tab_status` | Limit, spent and remaining, read from the chain, plus receipts |
| `close_tab` | Removes the rule, revoking the session key |

### Who `pay_and_fetch` can pay -- read this first

**It pays sellers whose x402 facilitator accepts a smart-account payer. It
does not pay arbitrary x402 endpoints today.**

An x402 seller hands payment verification to a facilitator. The public one,
`https://x402.org/facilitator`, refuses every payment from a Barkeep tab, for
two reasons measured on Testnet (`deployments/testnet.json`,
`doneTests.x402Spike`):

1. **Its event check.** Upstream `@x402/stellar` rejects any contract event
   that is not a `transfer`. The spending-limit policy emits
   `spending_limit_enforced` on every capped spend, so the thing that makes a
   tab a tab is what gets refused.
2. **Its fee ceiling.** 50,000 stroops by default; a smart-account transfer
   simulated at 324,039.

A seller like that answers the paid request with a refusal and nothing is
paid. `packages/mcp-server/src/facilitator.ts` is the same upstream
facilitator with exactly those two checks relaxed, each commented with the
upstream check it relaxes; a seller that points at it can be paid. Until
upstream accepts smart-account payers, that is the reach of this tool.

Per call, `max_amount` caps the price and identical calls (same tab, URL,
`max_amount` and optional `request_id`) pay once. Both are enforced by the
server; the tab's cap is enforced on chain. The money tools carry the
`anthropic/requiresUserInteraction` flag, so the host asks on every call.
Every payment appends a receipt -- tx hash, amount, endpoint, timestamp, tab
id -- to the state directory's `receipts.jsonl`.

### Run it

```sh
# the facilitator a seller points at (fees are paid by this key)
BARKEEP_FACILITATOR_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
  npx tsx packages/mcp-server/src/facilitator.ts        # http://127.0.0.1:4020

# the live done-tests: pay, over-cap refusal, idempotency
cd packages/mcp-server
BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
BARKEEP_AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
npx tsx scripts/pay-and-fetch-testnet.mjs
```

Results, with transaction hashes, are recorded under `doneTests.payAndFetch`
in `deployments/testnet.json`.

---

## Smart Contract (Soroban)

Barkeep's settlement layer is a Soroban contract that escrows XLM while a
payment is in flight and tracks its status on-chain.

### Deployment

| | |
| --- | --- |
| **Network** | Stellar Testnet (`Test SDF Network ; September 2015`) |
| **Contract ID** | `CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X` |
| **Wasm hash** | `06a0f8e8b789dc7dc4b66a0710506ae4a9940a5663e0f7ef0a8d477a307377f4` |
| **Settlement token** | Native XLM SAC — `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| **Deployer** | `GDMLL4EVSZHPFB3IES7XH72TNFITQ64G3S57SAHOE5L6LBZV4LPRZDJY` |
| **Source** | [contracts/payment-tracker/src/lib.rs](contracts/payment-tracker/src/lib.rs) |
| **Tests** | [contracts/payment-tracker/src/test.rs](contracts/payment-tracker/src/test.rs) |

### Proof of invocation

A real `create_payment` call against the deployed contract (escrowed 0.5 XLM,
payment id `3`, later released with `complete_payment`):

```text
Transaction hash:
d13babf0aefbad0edd6f2057a6b85f58b4d38dee3d26f3226091bfe833081c0d
```

* [View on stellar.expert](https://stellar.expert/explorer/testnet/tx/d13babf0aefbad0edd6f2057a6b85f58b4d38dee3d26f3226091bfe833081c0d)
* [View on Horizon (always live)](https://horizon-testnet.stellar.org/transactions/d13babf0aefbad0edd6f2057a6b85f58b4d38dee3d26f3226091bfe833081c0d)

The matching `complete_payment` is
[`c7b8739f…`](https://stellar.expert/explorer/testnet/tx/c7b8739f09343f51e38cd654aba3a3201241c0532c0cd052d9a3ec054eae1ecb)
([Horizon](https://horizon-testnet.stellar.org/transactions/c7b8739f09343f51e38cd654aba3a3201241c0532c0cd052d9a3ec054eae1ecb)).
The full invocation history is tabulated under
[Verified on-chain activity](#verified-on-chain-activity).

### Verify the deployment

* **stellar.expert** — [contract page](https://stellar.expert/explorer/testnet/contract/CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X)
* **Stellar Lab** — [contract page](https://lab.stellar.org/r/testnet/contract/CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X)
* **stellarchain.io** — [contract page](https://testnet.stellarchain.io/contracts/CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X)

Third-party Testnet indexers can lag behind the ledger by a while, so the
authoritative checks are Horizon and the contract's own interface, both of which
respond immediately:

* [All deployer transactions on Horizon](https://horizon-testnet.stellar.org/accounts/GDMLL4EVSZHPFB3IES7XH72TNFITQ64G3S57SAHOE5L6LBZV4LPRZDJY/transactions?order=desc)

Read the deployed contract's interface straight off the ledger:

```bash
stellar contract info interface --id CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X --network testnet
```

Query its live state without a wallet:

```bash
stellar contract invoke --id CDWVMXTDTU6DJUG3BDUKI6SK72VIAVTJ44VWCL2VZ7OX5TCRRVD7HH6X --source deployer --network testnet -- get_payment_count
```

### How the escrow works

```text
create_payment ──▶ [ Pending ]  XLM held by the contract
                       │
        complete_payment ──▶ [ Completed ]  XLM released to recipient
        cancel_payment   ──▶ [ Cancelled ]  XLM refunded to sender
```

`Completed` and `Cancelled` are terminal. Only a `Pending` payment can
transition, which is what makes double-complete and double-cancel impossible.
Both transitions are authorized by the **sender**, who either releases the
escrow to the recipient or claws it back.

### Contract interface

| Function | Kind | Description |
| --- | --- | --- |
| `initialize(token: Address)` | write | Sets the settlement token. Callable exactly once. |
| `create_payment(from: Address, to: Address, amount: i128) -> u32` | write | Escrows `amount` from `from` and records a `Pending` payment. Returns the new id. |
| `create_batch(from: Address, recipients: Vec<(Address, i128)>) -> Vec<u32>` | write | Multi-address flow: one independent payment per recipient in a single invocation. Returns the new ids. |
| `complete_payment(id: u32)` | write | Sender-authorized. Releases escrow to the recipient, status → `Completed`. |
| `cancel_payment(id: u32)` | write | Sender-authorized. Refunds escrow to the sender, status → `Cancelled`. |
| `get_payment(id: u32) -> Payment` | read | Full payment record. |
| `get_payment_count() -> u32` | read | Total number of payments ever created. |
| `get_sent_ids(addr: Address) -> Vec<u32>` | read | Ids of payments sent by an address. |
| `get_received_ids(addr: Address) -> Vec<u32>` | read | Ids of payments received by an address. |
| `get_token() -> Address` | read | The configured settlement token. |

A `Payment` record carries `id`, `from`, `to`, `amount`, `status`,
`created_at`, and `updated_at`.

### Events

Every state change emits a typed `#[contractevent]`, so the lifecycle is
decodable by explorers and generated clients. `from` and `to` are indexed
topics, which lets an indexer subscribe to a single counterparty.

| Event | Topics | Data |
| --- | --- | --- |
| `payment_created` | `from`, `to` | `id`, `amount` |
| `payment_completed` | `from`, `to` | `id`, `amount` |
| `payment_cancelled` | `from`, `to` | `id`, `amount` |
| `tracker_initialized` | — | `token` |

### Errors

| Code | Error | Raised when |
| --- | --- | --- |
| 1 | `AlreadyInitialized` | `initialize` is called twice |
| 2 | `NotInitialized` | No settlement token configured |
| 3 | `InvalidAmount` | Amount is zero or negative |
| 4 | `PaymentNotFound` | No payment with that id |
| 5 | `NotPending` | Payment is already `Completed` or `Cancelled` |
| 6 | `EmptyBatch` | `create_batch` called with no recipients |
| 7 | `BatchTooLarge` | `create_batch` exceeds 100 recipients |
| 8 | `SelfPayment` | Sender and recipient are the same address |

### Verified on-chain activity

Every function below was invoked against the deployed contract on Testnet:

| Action | Transaction |
| --- | --- |
| Deploy | [`9a75966a…`](https://stellar.expert/explorer/testnet/tx/9a75966a7c395228434f6774f0e831013cefaff474c2192dbd944660c2e143eb) |
| `initialize` | [`f3ef0fa5…`](https://stellar.expert/explorer/testnet/tx/f3ef0fa5f330e39e87e49f27d2baa38a89d413ca3bd82a6148314c2d9265e131) |
| `create_payment` (2 XLM, id 0) | [`875ccf85…`](https://stellar.expert/explorer/testnet/tx/875ccf85104e3368f568615e327ea4d3d9601e64c9f46e99765c6f8030538313) |
| `complete_payment` (id 0) | [`0c5f0faf…`](https://stellar.expert/explorer/testnet/tx/0c5f0faf9a56232f52898aebe7c7d1b2290a7551d2d9b72db014106ccf072cf6) |
| `create_batch` (2 recipients, ids 1 & 2) | [`f563d568…`](https://stellar.expert/explorer/testnet/tx/f563d56807a758a6bee84d097ca6aeee2f5d7af05a556a875c5227701cb74b61) |
| `complete_payment` (id 1) | [`4dcfe1bf…`](https://stellar.expert/explorer/testnet/tx/4dcfe1bfec29b8b8eca1d4276a5cf906b0a53084eda6b0d421408c025c78cd88) |
| `cancel_payment` (id 2) | [`50664433…`](https://stellar.expert/explorer/testnet/tx/50664433fb25b97965f0b4c2ac9c3c5957cf0a8cd07bb81958d750088b6a17d2) |
| `create_payment` (0.5 XLM, id 3) | [`d13babf0…`](https://stellar.expert/explorer/testnet/tx/d13babf0aefbad0edd6f2057a6b85f58b4d38dee3d26f3226091bfe833081c0d) |
| `complete_payment` (id 3) | [`c7b8739f…`](https://stellar.expert/explorer/testnet/tx/c7b8739f09343f51e38cd654aba3a3201241c0532c0cd052d9a3ec054eae1ecb) |

Every one of those transactions is confirmed successful on Horizon — for
example, the `create_payment` above landed in ledger 4380292:

```bash
curl https://horizon-testnet.stellar.org/transactions/875ccf85104e3368f568615e327ea4d3d9601e64c9f46e99765c6f8030538313
```

Re-completing payment `0` on the live contract correctly fails with
`Error(Contract, #5)` (`NotPending`), and `get_payment_count` returns `4`
(payments `0`–`3`). You can re-check the live state any time without a wallet:

```bash
node scripts/verify-live.mjs
```

### Frontend integration

The dApp talks to the deployed contract directly — there is no backend.

* [`src/contract/paymentTracker.ts`](src/contract/paymentTracker.ts) is a typed
  client. Read-only views run through Soroban RPC **simulation**, so listing
  payments costs nothing and needs no signature. State-changing calls are
  prepared against RPC, signed by **the connected wallet** (via
  StellarWalletsKit), submitted, and polled to
  confirmation.
* [`src/components/PaymentTracker.tsx`](src/components/PaymentTracker.tsx) is
  the UI panel. It lists the connected wallet's sent payments with live
  `Pending` / `Completed` / `Cancelled` status, offers **Complete** and
  **Cancel** on pending rows, and supports both a single payment and a
  multi-recipient batch.

Addresses and amounts are validated before a signing prompt is ever raised, and
contract error codes are mapped back to readable messages.

---

## Contract Development

### Prerequisites

* [Rust](https://rustup.rs/) with the `wasm32v1-none` target
* [Stellar CLI](https://developers.stellar.org/docs/tools/developer-tools/cli/install-cli) 27.x

```bash
rustup target add wasm32v1-none
```

### Test

```bash
cargo test
```

### Build

```bash
stellar contract build
```

The optimized wasm is written to
`target/wasm32v1-none/release/payment_tracker.wasm`.

### Deploy

Create and fund a Testnet identity:

```bash
stellar keys generate deployer --network testnet --fund
```

Deploy the contract:

```bash
stellar contract deploy --wasm target/wasm32v1-none/release/payment_tracker.wasm --source deployer --network testnet
```

Resolve the native XLM Stellar Asset Contract and wire it in as the settlement
token (this is the one-time `initialize` call):

```bash
stellar contract id asset --asset native --network testnet
```

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- initialize --token <NATIVE_SAC_ID>
```

### Invoke

Create an escrowed payment (amounts are in stroops; 1 XLM = 10,000,000):

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- create_payment --from <SENDER_G...> --to <RECIPIENT_G...> --amount 20000000
```

Release it to the recipient:

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- complete_payment --id 0
```

Pay several recipients in one invocation:

```bash
stellar contract invoke --id <CONTRACT_ID> --source deployer --network testnet -- create_batch --from <SENDER_G...> --recipients '[["<RECIPIENT_A>","10000000"],["<RECIPIENT_B>","15000000"]]'
```

---

## TRY on/off-ramp via SEP

Barkeep can move between **Turkish Lira and USDC** through a Stellar
anchor using only the portable SEP path — the standard interface every real
anchor exposes. No partner API key, no anchor-specific endpoints. The whole
hand-off is two config values (a **home domain** and an **asset code**);
everything else is discovered at runtime.

| SEP | Role | Where |
| --- | --- | --- |
| SEP-1 | Discovery: read `https://<home-domain>/.well-known/stellar.toml` for the auth, transfer and quote servers, the signing key and the USDC issuer | [src/services/anchor/sep1.ts](src/services/anchor/sep1.ts) |
| SEP-10 | Login: verify the anchor's challenge, sign it with the connected wallet, receive a JWT | [src/services/anchor/sep10.ts](src/services/anchor/sep10.ts) |
| SEP-38 | Firm quotes (TRY ⇄ USDC) shown before any transfer; the quote id locks the rate | [src/services/anchor/sep38.ts](src/services/anchor/sep38.ts) |
| SEP-6 | Deposit (bank transfer in, USDC out) and withdraw (USDC in with memo, TRY out), status polling, history | [src/services/anchor/sep6.ts](src/services/anchor/sep6.ts) |
| Horizon | USDC trustline check/creation and the memo'd USDC payment that settles a withdrawal | [src/services/anchor/horizon.ts](src/services/anchor/horizon.ts) |

The flows are composed in [src/services/anchor/index.ts](src/services/anchor/index.ts)
and rendered by the **TRY ⇄ USDC via anchor** panel
([src/components/TryRamp.tsx](src/components/TryRamp.tsx)), which appears
under the Payment Tracker once a wallet is connected.

Development target: the [TR Mock Anchor](https://tr-mock-anchor.fly.dev)
(Stellar Testnet, sandbox — no real money moves).

### Deposit: TRY → USDC (on-ramp)

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

### Withdraw: USDC → TRY (provider payout / off-ramp)

1. Enter a USDC amount and (optionally) get a quote.
2. Press **Withdraw**. The app opens the SEP-6 withdrawal, receives the
   anchor's Stellar account + memo, and asks the wallet to sign a USDC
   payment carrying that memo.
3. It polls until the anchor reports `completed` and shows the TRY paid, the
   bank reference and the Stellar transaction.

This is the payout path for an API provider that is paid in USDC on-chain and
wants TRY in the bank.

### Configuration (Testnet → Mainnet is a config change)

All network and anchor settings live in
[src/config/stellar.ts](src/config/stellar.ts) and are read from `VITE_*`
env vars (see [.env.example](.env.example)):

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

### Tests

```bash
npm test
```

Runs the offline unit suite (toml validation, SEP-10 challenge checks,
response parsing, error mapping, memo building; CI runs these via
`npm run test:unit`) **and** the live suite
([src/services/anchor/anchor.live.test.ts](src/services/anchor/anchor.live.test.ts)),
which creates a Friendbot-funded Testnet key and drives SEP-1 → SEP-10 →
SEP-38 → SEP-6 deposit (with trustline creation) → SEP-6 withdraw against the
mock anchor, moving real Testnet USDC. Set `SEP_SKIP_LIVE=1` to skip the live
suite offline.

The offline suite also covers the build's license gate
([build/](build/)): the allow-list, copyright extraction, and fixture builds
that must fail for AGPL, unlicensed and private copyleft packages.

### Demo script

```bash
npm run demo:sep
```

[scripts/sep-demo.ts](scripts/sep-demo.ts) prints every step with
timestamps: discovery, login, quote, IBAN + reference, simulated bank leg,
status transitions, USDC credit, quote, memo'd USDC payment, TRY payout and
history. Use `SEP_DEMO_SECRET=S...` to reuse a Testnet key, and
`SEP_DEMO_TRY` / `SEP_DEMO_USDC` to change the amounts.

### Notes on the mock anchor

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

## Multi-Wallet Support

Barkeep connects through
[StellarWalletsKit](https://stellarwalletskit.dev/), so the user picks their
wallet in a selection modal instead of being locked to one extension:

| Wallet | Type |
| --- | --- |
| Freighter | Browser extension |
| Albedo | Web-based signer |

xBull was removed on 2026-09-12: the kit's xBull module bundles
`@creit.tech/xbull-wallet-connect`, which ships without a license and whose
upstream repository is AGPL-3.0. The connector is no longer in the web bundle,
but `npm ci` still installs it, because StellarWalletsKit 2.6.0 pins it
exactly. See [License](#license).

![Wallet selection modal with multiple wallets](docs/screenshots/wallet-options.png)

The screenshot predates the xBull removal; the modal now lists Freighter and
Albedo.

The connect card also lists each wallet with a live **detected** badge or an
**install** link before any connection attempt. All signing — White Belt XLM
payments and Payment Tracker contract calls alike — goes through the kit, so
every flow works with whichever wallet the user chose.

Implementation: [src/services/wallet.ts](src/services/wallet.ts)

---

## Error Handling

Every failure funnels through one taxonomy in [src/errors.ts](src/errors.ts),
and the three review-relevant cases render with their own banner title,
message, and follow-up hint — not a generic catch-all:

| Error | Detection | User sees |
| --- | --- | --- |
| **Wallet not found** | Wallet availability is probed before connect (`getWalletOptions`), and a not-installed failure from the kit maps to `WALLET_NOT_FOUND` | "Wallet not found" banner naming the wallet, plus an install link for that wallet |
| **User rejected** | A declined connection or signature in the wallet maps to `USER_REJECTED` | "Request declined in wallet" banner, with a reassurance that nothing was submitted |
| **Insufficient balance** | Pre-checked against the spendable balance before any signing prompt, in both the XLM payment form and the Payment Tracker; `op_underfunded` / `tx_insufficient_balance` / SAC balance errors map to the same case if it slips through | "Insufficient balance" banner with the amounts, plus a Friendbot funding hint |

Wrong-network and Soroban contract error codes (`Error(Contract, #N)`) are
mapped in the same file.

---

## Real-Time Event Integration

The contract emits typed `#[contractevent]`s on every state change, and the
frontend consumes them without a backend:

* **Live payment list** — the tracker polls the contract's read-only views
  every 8 seconds, so a payment completed from anywhere (another browser, the
  CLI) transitions `Pending → Completed/Cancelled` on screen without a page
  refresh.
* **Contract event feed** — recent `payment_created` / `payment_completed` /
  `payment_cancelled` events are fetched straight from Soroban RPC
  (`getEvents`), decoded, and listed with amount, ledger, timestamp, and an
  explorer link per transaction.
* **In-flight transaction status** — submissions show a live indicator:
  *waiting for wallet signature* → *submitted, waiting for confirmation* (with
  the tx hash linked as soon as the network accepts it) → confirmed or a
  distinct error.

Implementation: [src/components/PaymentTracker.tsx](src/components/PaymentTracker.tsx)
and `fetchContractEvents` in
[src/contract/paymentTracker.ts](src/contract/paymentTracker.ts).

---

## Screenshots

### Wallet Connected

The application connects the selected wallet and displays the connected Stellar public address.

![Wallet Connected](docs/screenshots/wallet-connected.png)

---

### XLM Balance

Barkeep fetches the connected wallet's native XLM balance directly from Stellar Testnet through Horizon.

![XLM Balance](docs/screenshots/balance-testnet.png)

---

### Successful Testnet Transaction

A real XLM payment is created, signed in the connected wallet, submitted to Stellar Testnet, and confirmed by Horizon.

The interface displays the transaction hash and provides a direct link to the transaction on Stellar Expert.

![Successful Testnet Transaction](docs/screenshots/payment-success.png)

---

### Transaction Error Handling

Barkeep validates transaction inputs and provides clear failure feedback when a payment cannot be completed.

![Transaction Error](docs/screenshots/payment-error.png)

---

## How It Works

```text
User
  │
  ▼
Barkeep
  │
  ├── Connect wallet (kit modal)
  │
  ▼
Stellar Wallet (via kit)
  │
  ├── Public Stellar Address
  │
  ▼
Stellar Horizon Testnet
  │
  ├── Account Data
  └── XLM Balance

Payment Flow
  │
  ▼
Recipient + Amount
  │
  ▼
TransactionBuilder
  │
  ▼
XLM Payment Operation
  │
  ▼
Wallet Signature
  │
  ▼
Signed XDR
  │
  ▼
Stellar Horizon Testnet
  │
  ▼
Transaction Confirmed
  │
  ▼
Transaction Hash + Updated Balance
```

---

## Features

### Multi-Wallet Integration (StellarWalletsKit)

Barkeep opens a wallet-selection modal (Freighter, Albedo), shows which wallets are detected in the browser, and requests access to the user's Stellar public address.

Private keys are never exposed to Barkeep.

---

### Network Validation

The application reads the currently active network from the connected wallet.

Transactions are only allowed when the wallet is connected to:

```text
Stellar Testnet
```

If the wallet is connected to the public Stellar network instead, Barkeep displays a warning and prevents Testnet transaction activity.

---

### XLM Balance

Barkeep loads the connected Stellar account through Horizon and displays its native XLM balance.

The balance can also be manually refreshed from the interface.

---

### XLM Payments

Users can enter:

* A Stellar recipient address
* An XLM amount

Barkeep then:

1. Validates the destination address
2. Validates the amount
3. Confirms that the recipient exists on Stellar Testnet
4. Loads the sender's account
5. Builds an XLM payment transaction
6. Converts the transaction to XDR
7. Requests a signature from the connected wallet
8. Submits the signed transaction to Horizon
9. Displays the transaction result
10. Refreshes the wallet balance

---

### Transaction Feedback

Successful transactions display:

* Success confirmation
* Transaction hash
* Stellar Explorer link
* Updated XLM balance

Failed transactions display a clear error state to the user.

Examples include:

* Invalid Stellar addresses
* Recipient accounts that are not funded
* Incorrect network selection
* Invalid XLM amounts
* Rejected transactions

---

## Technology Stack

### Frontend

* React
* TypeScript
* Vite
* CSS

### Smart Contract

* Rust (`no_std`)
* Soroban SDK 27
* Stellar CLI 27
* `wasm32v1-none` target

### Stellar

* Stellar JavaScript SDK
* StellarWalletsKit (Freighter, Albedo)
* Stellar Horizon
* Soroban RPC
* Stellar Testnet

### Development

* ESLint
* Cargo
* Git
* GitHub

---

## Installation

### Prerequisites

Make sure the following are installed:

* Node.js 20+
* npm
* Git
* A supported Stellar wallet: the **Freighter** browser extension, or
  **Albedo** (web-based, nothing to install)

The wallet must be configured for **Stellar Testnet**.

For contract development additionally install Rust and the Stellar CLI — see
[Contract Development](#contract-development).

---

### Clone the Repository

```bash
git clone https://github.com/barbarosalagoz/barkeep.git
cd barkeep
```

---

### Install Dependencies

```bash
npm install
```

---

### Start the Development Server

```bash
npm run dev
```

Vite will provide a local development URL, typically:

```text
http://localhost:5173
```

Open it in a browser with your wallet available. No environment variables are
needed — the deployed contract ID and Testnet endpoints are part of the app
configuration
([src/contract/paymentTracker.ts](src/contract/paymentTracker.ts)). The
network and anchor can be overridden with the `VITE_*` variables in
[.env.example](.env.example); see [TRY on/off-ramp via SEP](#try-onoff-ramp-via-sep).

---

### Production Build

```bash
npm run build
```

The static site is emitted to `dist/`. `npm run lint` runs the ESLint suite,
`npm test` the Vitest suites (see [Tests](#tests)).

---

## Using Barkeep

### 1. Connect a Wallet

Click:

```text
Connect Wallet
```

Pick a wallet in the selection modal (Freighter or Albedo) and approve the connection request.

---

### 2. Switch to Testnet

Barkeep verifies the active Stellar network.

The application should display:

```text
✓ Stellar Testnet
Ready for test transactions.
```

---

### 3. Fund Your Testnet Wallet

A Stellar Testnet account must be funded before it exists on the Testnet ledger.

Use Stellar's Testnet funding tools to obtain test XLM.

Testnet XLM has no monetary value.

---

### 4. Check Your Balance

After the Testnet account is funded, Barkeep retrieves and displays the current XLM balance.

---

### 5. Send XLM

Enter:

```text
Recipient: G...
Amount: 1
```

Click:

```text
Send XLM
```

The connected wallet will open a transaction approval request.

Review the transaction and approve the signature.

---

### 6. Transaction Confirmation

After Horizon accepts the transaction, Barkeep displays:

```text
✓ Payment successful

Transaction Hash
xxxxxxxxxxxx...xxxxxxxxxxxx

View transaction ↗
```

The wallet balance is refreshed automatically after confirmation.

---

## Security

Barkeep never requests, stores, or handles a user's private key.

Transaction signing occurs inside the connected wallet.

The application only receives:

* The public Stellar address
* Wallet network information
* Signed transaction XDR after user approval

This project currently operates exclusively on **Stellar Testnet**.

---

## Project Structure

```text
barkeep/
│
├── Cargo.toml                     # Soroban workspace root
├── Cargo.lock
│
├── contracts/
│   └── payment-tracker/
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs             # Payment Tracker contract
│           └── test.rs            # contract unit tests
│
├── docs/
│   └── screenshots/
│       ├── wallet-connected.png
│       ├── balance-testnet.png
│       ├── payment-success.png
│       └── payment-error.png
│
├── src/
│   ├── App.tsx
│   ├── App.css
│   ├── index.css
│   ├── main.tsx
│   ├── errors.ts                  # error taxonomy: wallet not found,
│   │                              #   user rejected, insufficient balance...
│   ├── services/
│   │   └── wallet.ts              # multi-wallet service (StellarWalletsKit)
│   ├── components/
│   │   └── PaymentTracker.tsx     # tracker UI: live status, event feed
│   └── contract/
│       └── paymentTracker.ts      # typed client + RPC event fetching
│
├── build/
│   ├── third-party-licenses.ts    # emits /third-party-licenses.txt, license gate
│   └── license-overrides/         # upstream LICENSE texts for packages that ship none
│
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## Future Vision

With the Payment Tracker contract live on Testnet, Barkeep now has both
halves of a machine-payment system: an on-chain settlement layer and a wallet
frontend that drives it.

Future versions may introduce:

* Paid API endpoints
* Stablecoin payments
* Usage-based API billing
* AI agent payments
* Machine-to-machine payment flows
* Developer SDKs
* Payment analytics
* Mainnet support

The long-term idea is simple:

> Make digital services directly purchasable by software.

---

## License

The Barkeep source code in this repository is licensed under the
[Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).

Copyright 2026 Barbaros Emre Alagöz

Revisions up to and including commit `49a2b12` were released under the MIT
License.

Third-party dependencies, including the packages bundled into the web build,
remain under their own licenses. Each build ships their license texts and
copyright notices at `/third-party-licenses.txt`, generated during
`npm run build` by [rollup-plugin-license](https://github.com/mjeanroy/rollup-plugin-license)
(MIT). The build fails if a bundled package is unlicensed or uses a license
outside the permissive allow-list in `build/third-party-licenses.ts`.
