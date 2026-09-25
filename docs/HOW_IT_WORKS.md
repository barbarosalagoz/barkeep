# How Barkeep works

A walkthrough for a developer with no context. It follows one payment from
the human opening a tab to the line on the bill, and names the file that does
each step. Testnet only. None of the contracts is audited. See
[ARCHITECTURE-v2.md §4.1](ARCHITECTURE-v2.md#41-what-is-audited-and-what-is-not)
before repeating any claim to the contrary.

## The problem in one paragraph

An AI agent in Claude Code wants to fetch a URL that costs money. The human
running it wants to say "spend up to this much, on these sellers, for the next
hour" once, and not be asked about every request. If the limit lives in the
agent's prompt or in the server the agent talks to, a bug or a jailbreak
removes it. So the limit has to live where the money is. And the agent has to
hold a key that can spend against that limit and nothing else. That is what a
tab is.

## Why a smart account

A classic Stellar account (a G-address) authorises with a signature and
nothing more. There is nowhere to put "only up to this much". A Soroban
contract account (a C-address) authorises through its own `__check_auth`
function. The host calls it whenever the account has to approve something.
Whatever that function checks is the account's policy, and the ledger enforces
it.

Barkeep's account is `contracts/barkeep-smart-account/src/lib.rs`. It is short
because OpenZeppelin's `stellar-accounts` library supplies the storage and the
authorisation logic as traits with default bodies. The contract exposes those
defaults. It implements `__check_auth` by delegating to the library's
`do_check_auth`. It has one hand-written constructor. The constructor installs
the first context rule directly, because the library's own `add_context_rule`
requires the account's authorisation and an account with no signers cannot
give it. One thing to keep in mind: nothing in `stellar-accounts` is
deployable. It is a library, not a set of contracts. Every contract on chain
here was written in this repository, and I found that out late
([finding 03](findings/03-what-audited-covers.md)).

The account needs two more contracts to function. Both are thin wrappers that
give a library function an address: `contracts/barkeep-verifier-ed25519` for
the agent's key and `contracts/barkeep-verifier-webauthn` for a passkey. The
account calls them by address to check a signature. My passkey is registered
as rule 31, a `Default` rule of its own. It is verified on chain by a transfer
it alone authorised (`deployments/testnet.json`, `doneTests.passkeySign`). It
is bound to `http://localhost:8000`, the origin I created it on. It works on
chain anyway because the verifier skips origin and rpIdHash checks
(`docs/DEPLOYMENTS.md`, "Registering the human signer's passkey"). The ed25519
key stays on rule 0 as a second human path. The first WebAuthn verifier I
deployed could never be called by the account, and I only found that out when
I went to register the passkey
([finding 06](findings/06-webauthn-verifier-sig-data-not-xdr.md)).

## Why a context rule

`stellar-accounts` organises an account's permissions as context rules. A
rule says: for this kind of context, these signers may authorise, these
policies must pass, and the rule dies at this ledger. Rule 0 is created by the
constructor with the `Default` context type, which matches anything, and holds
the human signer. That is the admin rule.

A tab is a second rule, and the shape of it is the whole product:

- context type `CallContract(<token>)`, so it matches only calls to the one
  token contract;
- one signer, the agent's ed25519 session key;
- two policies, the spending limit and the payee allowlist;
- `valid_until`, the expiry ledger.

`packages/mcp-server/src/tabs.ts`, `openTab`, builds exactly that and sends
`add_context_rule` to the account, signed by the human signer under rule 0.
The spending-limit policy (`contracts/barkeep-policy`) is the library's
rolling-window limit given an address. It stores the cap, the window in
ledgers, a history and a cached total. It refuses with `Error(Contract, #3221)`
when a transfer would take the window's total past the cap. The payee
allowlist (`contracts/barkeep-payee-allowlist`) is Barkeep's own, because the
library ships none. It reads the transfer's `to` and refuses with `#3901` if
it is not listed. Both run inside `__check_auth`. Either one panicking refuses
the authorisation, so they compose as AND.

Two things follow. `tab_status` does not trust its own records. It reads the
policy's window state and the rule's payee list from the chain
(`packages/tab-read/src/read.ts`), so a transfer made outside the server shows
up. And the allowlist fails closed. `open_tab` with neither `payees` nor
`allow_any_payee: true` is refused before a ledger is read. A tab that may pay
anyone is one on which the allowlist is not installed.

## Why the agent key is separate

The agent's key can do one thing. It can authorise a `transfer` on one token,
under one rule, within the cap, to listed payees, until the expiry. It cannot
add a payee: `add_payee` is a call to the policy contract, the tab's rule
matches only calls to the token, and the account refuses with `#3002` before
the policy is consulted. It cannot open or close a tab, because those are
calls to the account, same reason. Closing the tab removes the rule. After
that the same key with the same transfer gets `#3000`, `ContextRuleNotFound`.

The human signer's key is a different key on a different rule. The MCP server
process holds both today, and that is a stated limit: the contract stops the
agent's key, not a process holding both keys (`docs/DEPLOYMENTS.md`, "The
payee allowlist"). The passkey is what separates them. It is registered as
rule 31 and has signed on chain. The server still reads the ed25519 admin key,
so the separation is available and I have not used it yet.

The only key Barkeep writes is each tab's own agent key. `open_tab` makes a
fresh one per tab, and `close_tab` destroys it
(`packages/mcp-server/src/agentKeys.ts`). It is one mode-600 file in a
separate directory next to the state directory, not inside it.
`packages/mcp-server/bin/barkeep-mcp` is the wrapper Claude Code launches. It
reads the admin and submitter secrets from the Stellar CLI's key store at
start and passes them through the environment, so the MCP registration holds a
path and nothing else. It also reads the older shared agent key if it exists,
for tabs opened before per-tab keys. `packages/mcp-server/src/state.ts` holds
tab metadata, receipts and idempotency records, and a test asserts no secret
lands there. This
departs from my architecture plan, which had put the session key in the
plugin's data directory. Keeping a spending key next to the record of what it
may spend was not worth one saved environment variable.

There is a fourth key, the submitter. The transaction that carries an
`add_context_rule` or a `transfer` needs a source account to pay its fee and
burn a sequence number, and a C-address cannot be one. `Chain` in
`packages/mcp-server/src/chain.ts` uses the deployer's key for that. It
authorises nothing.

## What the agent signs

The host hands the account a 32-byte `signature_payload`. An external signer
on a `stellar-accounts` 0.7.2 account does not sign that. It signs

```
sha256(signature_payload || context_rule_ids.to_xdr())
```

so the rule it is claiming is bound into the signature. A signature gathered
for the capped rule cannot be presented against the admin rule.
`packages/mcp-server/src/authDigest.ts` computes that digest and assembles the
`AuthPayload` the account expects. The library ships no client helper for
this, so the test vectors come from the contract itself. A Rust test emits
them, and `authDigest.test.ts` asserts the TypeScript reproduces them.
`Chain.signAs` in `chain.ts` is the signer callback that does this for any key
and rule id.

The account is not in that digest. That is
[finding 02](findings/02-auth-digest-not-account-scoped.md).
`authDigestPreimage.ts` next to it is the client side of the fix on the
unpublished `v0.9.0` branch.

## Why the facilitator exists at all

x402 is a protocol for paying for HTTP. The seller answers a request with 402
and a `PAYMENT-REQUIRED` header describing what it accepts. The client retries
with a `PAYMENT-SIGNATURE` header carrying a payment payload. The seller hands
that payload to a facilitator. The facilitator verifies it, submits it to the
chain and tells the seller it settled.

On Stellar the payload is a transaction XDR whose one operation is
`transfer(from, to, amount)` on the token, with the payer's authorisation entry
signed. The facilitator discards the envelope, rebuilds the transaction with
its own source account and submits it. So the payer pays no fee and spends no
sequence number. For a C-address payer that is not a convenience. It is what
makes paying possible at all, because the smart account has no sequence number
to spend.

`packages/mcp-server/src/x402Scheme.ts` is Barkeep's client scheme. It builds
the transfer with the smart account as `from`. It simulates once to learn
which authorisation entry is needed. It signs that entry through `Chain.signAs`
under the tab's rule. Then it simulates again with the signed entry attached.
The second simulation is where the account's `__check_auth` runs, so an
over-cap or off-list payment is refused here, before anything is sent to the
seller. The stock `@x402/stellar` client cannot do this. It hands the SDK raw
signature bytes, which take the classic-account path and fail on a C-address.

The public facilitator at `x402.org` refuses the result anyway
([finding 01](findings/01-x402-public-facilitator-refuses-policy-events.md)).
Its fee ceiling is below what a `__check_auth` that calls a verifier costs.
Its event check refuses the `spending_limit_enforced` event the policy emits.
`packages/mcp-server/src/facilitator.ts` is the upstream facilitator with
those two checks relaxed and nothing else changed. Each relaxation is
commented with the upstream check it relaxes. It pays fees from its own key,
never the deployer's. It runs settlements one at a time because upstream's
`settle` takes the signer's sequence number without a lock.
`packages/mcp-server/src/seller.ts` is a seller that points at it, for demos.

The consequence: `pay_and_fetch` pays sellers whose facilitator accepts a
smart-account payer, and today that means one running Barkeep's. It does not
pay arbitrary x402 endpoints. The tool description and the README both say so.

## One payment, step by step

`packages/mcp-server/src/pay.ts`, `createPayer`.

1. The agent calls `pay_and_fetch(url, max_amount)`. The tool carries the
   `anthropic/requiresUserInteraction` flag, so the host asks the human on
   every call.
2. The server looks up the request key `(tab, url, max_amount, request_id)`.
   A settled record is returned as-is with `replayed: true`. A pending or
   unconfirmed record refuses to pay again.
3. It fetches the URL. Anything but 402 is returned unpaid.
4. It decodes `PAYMENT-REQUIRED`, keeps the offers that are `exact` on
   `stellar:testnet` in the tab's token, and takes the cheapest. No usable
   offer is a refusal, written to the bill.
5. Price above `max_amount` is a refusal, written to the bill, before anything
   is signed.
6. It writes a `pending` record. This happens before the signature exists, so
   a crash from here on leaves a record that blocks a second payment.
7. `x402Scheme.ts` builds, signs and simulates as above. An `AccountRefusal`
   here carries the contract error. `accountRefusalMessage` turns it into one
   sentence with the numbers: price against remaining cap for `#3221`, the
   payee for `#3901`, expiry for `#3002`, closed for `#3000`.
8. It retries the URL with `PAYMENT-SIGNATURE`. The seller's facilitator
   verifies, rebuilds, submits. The seller answers with the resource and a
   `PAYMENT-RESPONSE` header carrying the transaction hash.
9. The record becomes `settled` and a receipt is appended. If the second
   fetch throws, the record becomes `unconfirmed` and is never retried
   automatically, because the payment may have settled.

The done-test for this sequence is
`packages/mcp-server/scripts/pay-and-fetch-testnet.mjs`, with its hashes under
`doneTests.payAndFetch` in `deployments/testnet.json`. It runs a payment, two
concurrent identical calls producing one transaction, and an over-cap payment
refused at step 7 and then forced on chain so the refusal has a hash.

## What the bill is

The bill is `receipts.jsonl` in the state directory, append-only, one JSON
object per line. `packages/tab-read/src/receipts.ts` defines the shape, and
`state.ts` writes it. Every tab open and close is a receipt. Every payment is
a receipt with the transaction hash, amount, payee, endpoint, timestamp and
tab id. Every refusal is a receipt too, with who refused (the per-call cap,
the payment terms, the on-chain policy, signing) and why. A bill that lists
only successes hides the refusals that show the limits working. Every receipt
carries `allow_any_payee`, so a tab that could pay anyone is visible as such
on every line.

`tab_status` shows the numbers and the recent receipts together. The numbers
come from the chain, the receipts from the file, and the two can legitimately
disagree: a transfer made outside the server appears in the numbers and not
on the bill. The dashboard that renders this file is not built. The design is
in ARCHITECTURE-v2 §6, and `@barkeep/tab-read` exists so the server and the
dashboard read the same file with the same definitions.

## Three traps you will hit too

### Recording-mode simulation does not run `__check_auth`

The first `simulateTransaction` on an invocation that needs the account's
authorisation runs in recording mode. It reports which authorisation entries
are needed and nothing else. The account's `__check_auth`, and therefore every
policy, does not run. An over-cap transfer passes this simulation. The refusal
appears only when you simulate a second time with the signed entries attached.
A client that stops after the first simulation reports success for a transfer
the ledger is about to refuse. `chain.ts` and `x402Scheme.ts` both simulate
twice for this reason. There is a corollary. A refused invocation returns no
transaction data, so it cannot be assembled and submitted. To put a refusal on
chain for the record, `Chain.send` has a `force` option that builds the auth
entry by hand and reuses a known-good footprint. That is how the over-cap and
after-expiry refusals in `deployments/testnet.json` got their hashes. I hit
this writing the first lifecycle script, and the fix is recorded in commit
98f3577.

### Call `transfer` on the token, not `execute` on the account

The library account has an `execute` entry point that runs an arbitrary call.
Going through it produces an authorisation context of `contract = account,
fn_name = "execute"`. A `CallContract(token)` rule does not match that, and
the account refuses with `#3002` before any policy sees the call. Calling the
token's `transfer` directly with the account as `from` produces exactly one
context, `contract = token, fn_name = "transfer"`. That is what the rule
matches and what the spending-limit policy reads (it handles only `transfer`
and takes the amount from `args.get(2)`). The comment is in
`packages/mcp-server/scripts/tab-lifecycle-testnet.mjs` above `transferOp`. I
hit this in the same script, before the first successful transfer.

### A delegated signer's entry is not returned by simulation

Barkeep uses external signers only, so I did not hit this in the product. I
hit it reproducing the `v0.9.0` client flow with a delegated signer. It is the
trap behind two upstream issues (OpenZeppelin/stellar-contracts#839 and #863).
A delegated signer authorises through `require_auth_for_args` inside
`__check_auth`. Recording-mode simulation never runs `__check_auth`, so it
never reports that entry. The raw simulation returned one entry, for the
account, and none for the delegate (case D0 in `deployments/testnet-v09.json`).
The client must add a second root-level entry itself, for the delegate's
address, whose invocation is `__check_auth` on the account with the preimage
as its single argument. `packages/mcp-server/src/authDigestPreimage.ts`,
`delegateAuthInvocation`, builds it. Without it the transaction looks complete
and traps on chain (D2). With the wrong argument it traps identically (D3).
With it, it succeeds (D1).

## What is not here

The bill dashboard and plugin packaging are unbuilt. The passkey signer is
registered (rule 31) and has signed on chain, but `bin/barkeep-mcp` does not
use it yet, and the passkey is bound to `localhost:8000`. The account is on
`stellar-accounts` 0.7.2 with the digest gap above. The migration is written
down but not started. The facilitator is Barkeep's, so the set of payable
sellers is the set that point at it. Mainnet is closed until a policy review.
The escrow contract under `contracts/payment-tracker` and the SEP ramp under
`packages/web` are earlier work, preserved and not part of the tab.
