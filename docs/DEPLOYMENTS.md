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

That path is the Stellar CLI's own config directory (`$XDG_CONFIG_HOME/stellar`,
falling back to `~/.config/stellar`). It is outside the repository entirely, so
there is no gitignore rule to get wrong and no way for `git add` to reach it —
which is the point of using the CLI's store rather than a dotfile in the tree.

`.gitignore` additionally excludes `.env*` (except `.env.example`) and a
`secrets/` directory, so that a key pasted into the working tree by mistake is
not staged. That is a backstop, not the mechanism.

To recreate the deployer on another machine:

```sh
stellar keys generate barkeep-testnet-deployer --network testnet --fund
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

Registering the key on the account is then `add_signer` with
`Signer::External(<webauthn verifier>, <public key>)` — not a redeploy. The
smart account currently carries an Ed25519 human signer as a stand-in.

A passkey is bound to the origin it was created on, so one made at
`localhost:8000` belongs to `localhost`. It still works on chain because the
verifier deliberately skips origin and rpIdHash validation
(`docs/ARCHITECTURE-v2.md` §4). Re-register per origin once that gap closes.

## MCP server state

`@barkeep/mcp` keeps tab metadata and an append-only receipt log outside the
repository, at the first of:

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
never written. `src/server.test.ts` asserts this against the real files.

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
