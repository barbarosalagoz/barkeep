# Deployments and keys

**None of the contracts recorded here is audited.** They are written in this
repository and run on Testnet only. The OpenZeppelin audits cover the
`stellar-accounts` *library* at v0.7.0-rc.1 — four tags behind the 0.7.2 we
depend on — and cover none of this code. See `docs/ARCHITECTURE-v2.md` §4.1
before repeating any audit claim.

Testnet only. Mainnet is closed until the policy review in
`docs/ARCHITECTURE-v2.md` constraint 4 and §10 risk 2 is done.

## What is in the repo, and why

`deployments/testnet.json` holds the deployed contract ids, their wasm hashes
and the deploy transaction hashes.

These are **not secrets**. A contract id is a public ledger address: anyone can
read it off the chain, and holding it grants nothing — calls still have to be
authorised by keys. Committing them is what makes a deployment reproducible
rather than something that lives in one person's shell history, and it lets the
web app, the MCP server and the scripts agree on which contracts they mean.

The wasm hash is worth keeping next to the id: it is how you confirm that the
contract at that address is the code in this repo, by rebuilding and comparing.

## What is NOT in the repo

**No secret key material, ever.** Not the deployer's, not a session key's, not a
passkey's.

The Testnet deployer is a Stellar CLI identity:

| | |
| --- | --- |
| Identity name | `barkeep-testnet-deployer` |
| Public key | `GAM225BSUJZCO3GHNOSW3APCUI5XNX2ECN27A7CAMSLL3EHGEYMWLGHT` |
| Secret stored at | `~/.config/stellar/identity/barkeep-testnet-deployer.toml` |

The other Testnet identities, in the same store:

| Identity name | Public key | Used by |
| --- | --- | --- |
| `barkeep-testnet-admin` | `GAPL4FFWCJ7TLUYU6USLKLXEFR7QIFVQ3XCEVTKO5MNDBO4IQYV5NK44` | open_tab / close_tab, the rule-0 signer |
| `barkeep-testnet-agent` | `GDUQYLCSWA3CTGCK7XHAW622QRX54Q3FZQWOYUICUNLZZQOHCOXQD5TS` | the tab's session key |
| `barkeep-testnet-facilitator` | `GACGJIUBFQ2O7RYX26QVGALAQG5BQ6DQI6JNHJ6TPOZE6MHJD7AM5OVK` | pays x402 settlement fees; never the deployer |
| `barkeep-testnet-seller` | `GASFR7KGGFZR5ODT37BRCHSGK3UP4ULDUV4QU7IAN42ABVCTC53H77H7` | the demo seller's payTo; holds a TAB trustline |

`packages/mcp-server/bin/barkeep-mcp` reads admin, agent and deployer from
this store each time Claude Code launches the server, so the MCP registration
holds a path and no secret.

That path is the Stellar CLI's own config directory (`$XDG_CONFIG_HOME/stellar`,
falling back to `~/.config/stellar`). It is outside the repository entirely, so
there is no gitignore rule to get wrong and no way for `git add` to reach it —
which is the point of using the CLI's store rather than a dotfile in the tree.

`.gitignore` additionally excludes `.env*` (except `.env.example`) and a
`secrets/` directory, so that a key pasted into the working tree by mistake is
not staged. That is a backstop, not the mechanism.

To recreate the identities on another machine:

```sh
stellar keys generate barkeep-testnet-deployer --network testnet --fund
stellar keys generate barkeep-testnet-facilitator --network testnet --fund
stellar keys generate barkeep-testnet-seller --network testnet --fund
```

It is a throwaway Testnet account funded by Friendbot. If it is lost, generate
another and redeploy; nothing of value is held by it.

## Registering the human signer's passkey (manual)

Creating a passkey is `navigator.credentials.create()` — a browser API backed by
an authenticator. There is no Node equivalent, and neither the Stellar CLI nor
any installed package offers one, so this step is done by hand.

`scripts/passkey-register.html` is a local page for it. `file://` does not work:
the origin is `null` and WebAuthn refuses it. `http://localhost` is a secure
context and does.

```sh
python3 -m http.server 8000 --directory scripts
open http://localhost:8000/passkey-register.html
```

Click **Create passkey**, approve with Touch ID / Windows Hello / a security
key, then **Test an assertion**. The page prints two public values — the
65-byte uncompressed secp256r1 public key and the credential id — and nothing
else. The private key is generated inside the authenticator and never leaves
it; the page makes no network requests.

The page forces `alg: -7` (ES256), the only curve the verifier supports, and
requires user verification, because the contract rejects an assertion with the
User Verified flag unset (3117). The assertion test is worth running: it is
better to discover an authenticator that will not set UV here than at signing
time.

Registering the key on the account is a new `Default` context rule that holds
the passkey alone, added under rule 0's authority. Not a redeploy, and not
`add_signer` on rule 0: in 0.7.2 a rule without policies requires every one of
its signers, so a second signer on rule 0 would make every admin call 2-of-2,
and the ed25519 stand-in could not remove the passkey again without an
assertion.

```sh
cd packages/mcp-server
BARKEEP_ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
PASSKEY_PUBLIC_KEY_HEX=04... PASSKEY_CREDENTIAL_ID_HEX=... PASSKEY_ORIGIN=http://localhost:8000 \
npx tsx scripts/add-passkey-rule-testnet.mjs            # validate + simulate
npx tsx scripts/add-passkey-rule-testnet.mjs --submit   # add the rule
```

`key_data` is the 65-byte point followed by the credential id; the verifier
verifies against the first 65 bytes and `canonicalize_key` strips the rest, so
the credential id rides along for a browser to find later.

Done on 2026-09-15: rule 31, `"passkey"`, tx `47448d91…8657bd`
(`deployments/testnet.json`, `contracts.smartAccount.passkeySigner`). The
Ed25519 signer stays on rule 0, so the account has two human admin paths.

A passkey is bound to the origin it was created on, so one made at
`localhost:8000` belongs to `localhost`. It still works on chain because the
verifier deliberately skips origin and rpIdHash validation
(`docs/ARCHITECTURE-v2.md` §4). Re-register per origin once that gap closes.

## Signing with the passkey (manual)

`navigator.credentials.get()` is a browser API too, so signing is a two-step
handoff around `scripts/passkey-sign.html`, served from the same origin as the
registration page:

```sh
cd packages/mcp-server
BARKEEP_SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
npx tsx scripts/passkey-sign-testnet.mjs prepare --rule 31      # prints a URL
# open it, click "Sign with passkey", copy the JSON
npx tsx scripts/passkey-sign-testnet.mjs submit --assertion '<json>'
```

`prepare` builds a small TAB transfer from the smart account, fixes its auth
entry (nonce, expiry ledger), and computes the digest the account will ask the
passkey for, `sha256(signature_payload || context_rule_ids.to_xdr())`, the
same one the ed25519 path signs. That digest goes to the page in the URL
fragment as the WebAuthn challenge; the fragment never reaches the server and
carries nothing secret. The page converts the DER signature to raw `r || s`,
normalises it to low-S (Soroban's `secp256r1_verify` refuses high-S), checks
the flags, and prints one JSON blob. `submit` wraps it as the XDR of
`WebAuthnSigData`, which is what the verifier decodes, simulates in enforcing
mode so `__check_auth` actually runs, submits, and reads the result back from
RPC and Horizon. The prepared transaction waits in the state directory as
`passkey-pending.json`, public values only.

The whole path was rehearsed with a throwaway passkey from a Chromium virtual
authenticator before the human's key was registered: `doneTests.passkeyRehearsal`
in `deployments/testnet.json`, and `docs/findings/06`, which is also where the
first WebAuthn verifier deployment turned out to be uncallable by the account
and was replaced.

To remove a rule the server never recorded, for instance after a rehearsal:

```sh
npx tsx scripts/remove-context-rule-testnet.mjs <rule id>   # refuses rule 0
```

## MCP server state

`@barkeep/mcp` keeps tab metadata, an append-only receipt log and
pay_and_fetch's idempotency records (`payments.json`, which includes the
truncated bodies of resources already paid for) outside the repository, at the
first of:

1. `$BARKEEP_STATE_DIR` — explicit override, used by the tests
2. `$CLAUDE_PLUGIN_DATA/barkeep` — set by the host when Barkeep runs as a Claude
   Code plugin, and survives plugin updates, which is the point (§5)
3. `$XDG_STATE_HOME/barkeep`
4. `~/.local/state/barkeep`

Not the repository: this is per-machine runtime state, not source, and it would
be one bad `git add` from being committed. Not a temp directory either — tabs
outlive a reboot, and a tab whose record vanished is a live on-chain rule that
nobody can close by id.

**It holds no key material.** Contract ids, ledger numbers, amounts, transaction
hashes and the agent's *public* key. Signing keys are read from the environment
(`BARKEEP_ADMIN_SECRET`, `BARKEEP_AGENT_SECRET`, `BARKEEP_SUBMITTER_SECRET`),
never written. Barkeep's x402 facilitator (`src/facilitator.ts`) reads
`BARKEEP_FACILITATOR_SECRET`, the key that pays settlement fees; it authorises
no payment. `src/server.test.ts` asserts this against the real files.

This departs from §5, which puts "the session key" in the plugin data
directory. Storing a spending key next to the metadata describing what it may
spend is worth avoiding when the alternative costs one environment variable.

## Reproducing a deployment

```sh
stellar contract build --package barkeep-verifier-ed25519
stellar contract build --package barkeep-verifier-webauthn
stellar contract deploy --wasm target/wasm32v1-none/release/<name>.wasm \
  --source barkeep-testnet-deployer --network testnet
```

Then check the deployed contracts actually work:

```sh
./scripts/verify-verifiers-testnet.sh
```

That runs the §4 done-test against the live contracts: each verifier accepts a
known-good signature fixture and rejects a bad one. It is read-only.

## The payee allowlist

`contracts/barkeep-payee-allowlist` (`policyPayeeAllowlist` in
`deployments/testnet.json`) is Barkeep's own policy contract, not
OpenZeppelin's: `stellar-accounts` 0.7.2 ships no payee allowlist. It is
unaudited like everything else here.

```sh
stellar contract build --package barkeep-payee-allowlist
stellar contract deploy --wasm target/wasm32v1-none/release/barkeep_payee_allowlist.wasm \
  --source barkeep-testnet-deployer --network testnet
```

`open_tab` installs it on the tab's rule next to the spending limit. Changing a
live tab's list is the human signer's job, not a tool: `add_payee` and
`remove_payee` on the policy, authorised by the account under rule 0.
`remove_payee` refuses to empty the list (3902); close the tab instead.

```text
# add a payee to tab rule <id> (the account authorises through rule 0's signer)
add_payee(context_rule_id: <id>, payee: <G... or C...>, smart_account: <account id>)
```

`packages/mcp-server/scripts/payee-allowlist-testnet.mjs` does exactly this in
test A3, through `Chain.send` with the admin key and rule 0. The done-tests are
recorded under `doneTests.payeeAllowlist`.

Today the admin key that can change the list sits in the same environment as
the agent key (`bin/barkeep-mcp` reads both). The contract stops the agent's
*key*; it does not stop a process holding both keys. The passkey signer is what
separates them. It exists since 2026-09-15 (rule 31), but `bin/barkeep-mcp`
still reads the ed25519 admin key, so the separation is available and not yet
used by the server.

## The 4529d70 deployment, alongside 0.7.2

`deployments/testnet-v09.json` records a second, independent set of the same
contracts built on `stellar-accounts` commit `4529d70`
(OpenZeppelin/stellar-contracts#868, `AuthDigestPreimage`), from the
`contracts/barkeep-v09-*` crates. `deployments/testnet.json` and the 0.7.2
contracts are untouched: they are the recorded baseline, and the MCP server
still uses them.

The same file holds the done-tests and the client-flow results on that set,
plus two throwaway 0.7.2 accounts (deployed from the installed 0.7.2 wasm hash)
used only for the cross-account replay baseline. Reproduce with, from
`packages/mcp-server`:

```sh
ADMIN_SECRET=$(stellar keys secret barkeep-testnet-admin) \
AGENT_SECRET=$(stellar keys secret barkeep-testnet-agent) \
SUBMITTER_SECRET=$(stellar keys secret barkeep-testnet-deployer) \
npx tsx scripts/v09-tab-lifecycle-testnet.mjs     # or v09-client-flow-testnet.mjs
```

Smart accounts take their admin signer through the constructor:

```sh
stellar contract deploy --wasm target/wasm32v1-none/release/barkeep_v09_smart_account.wasm \
  --source barkeep-testnet-deployer --network testnet -- \
  --admin_signer '{"External":["<v09 ed25519 verifier id>","<admin ed25519 key hex>"]}' \
  --name barkeep-v09-tab
```
