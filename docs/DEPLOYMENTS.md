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
