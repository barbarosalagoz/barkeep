# Key management

How Barkeep's keys are generated, stored, rotated and destroyed. It covers:
- the Stellar Testnet deployment in this repository;
- the Arc mainnet run in
  [barbarosalagoz/barkeep-arc](https://github.com/barbarosalagoz/barkeep-arc),
  the only record in this project that involves real funds;
- the loss of the Arc Testnet keys.

Barkeep runs on **Stellar Testnet only**. Its contracts are **unaudited**, and
it has **no external users yet**.

Everything below comes from the repositories' own records, or from what was
observed on the machine that ran them, with the date given. Arc references
are pinned to commit
[`5c211a5`](https://github.com/barbarosalagoz/barkeep-arc/tree/5c211a5).
Where the record is silent, this file says "not recorded".

## Summary

| Key | Chain | Generated | Stored | Rotated | Destroyed |
| --- | --- | --- | --- | --- | --- |
| Deployer / submitter | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No; a throwaway Testnet account |
| Admin (rule-0 signer) | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Agent session key, per tab | Stellar Testnet | By `open_tab`, fresh for each tab | One mode-600 file per key, in a mode-700 directory outside the state directory | A new key for every tab | Yes, by `close_tab` (overwrite, then remove). Offline-tested; **not yet run on Testnet** |
| Shared agent key (older tabs, done-test scripts) | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Facilitator fee payer | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Demo seller | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Human signer passkey | Stellar Testnet | Inside the authenticator (WebAuthn) | Inside the authenticator; never leaves it | — | Not recorded |
| Any key | **Stellar mainnet** | **None exists** | — | — | — |
| Owner | Arc mainnet | `barkeep-arc-owner keygen`, fresh for each funding attempt | `keys.json`, mode 600 | A new key per attempt | Two unused keys destroyed. The funded key's file no longer exists on the machine (see below) |
| Agent, per tab | Arc mainnet | By the MCP server when a tab opens | One mode-600 file per tab, in a mode-700 directory | One key per tab | Yes, by `close_tab`. The directory is empty |
| Demo seller, second seller | Arc mainnet | Named keys in `keys.json` | `keys.json`, mode 600 | — | The file no longer exists on the machine (see below) |
| Deployer, relayer, seller, demo agent | Arc Testnet | As above | `~/.local/state/barkeep-arc` on a Mac | — | **Lost** on 2026-09-21 (see below) |

## Stellar Testnet (this repository)

### Generation

**Long-lived identities.** These are Stellar CLI identities made with
`stellar keys generate … --network testnet --fund`, funded by Friendbot
([DEPLOYMENTS.md](DEPLOYMENTS.md#what-is-not-in-the-repo)). DEPLOYMENTS.md
lists their public keys:
- `barkeep-testnet-deployer`
- `barkeep-testnet-admin`
- `barkeep-testnet-agent`
- `barkeep-testnet-facilitator`
- `barkeep-testnet-seller`

Some done-tests also used fresh Friendbot accounts made for that run only,
such as the x402 spike's T0 payer and the payee-allowlist test's payees
(`deployments/testnet.json`).

**Per-tab agent keys.** Since commit `5d0b427`, `open_tab` makes a fresh
ed25519 key for each tab (`packages/mcp-server/src/agentKeys.ts`). The key
never needs a funded account. It is a signer on the tab's context rule,
checked by the ed25519 verifier contract. Tabs recorded before that commit,
and the done-test scripts, used the shared `barkeep-testnet-agent` key.

**The human signer's passkey.** It is created in the browser with
`navigator.credentials.create()` (`scripts/passkey-register.html`), and its
private key is generated inside the authenticator and never leaves it. Only
the public key and the credential id are registered on the account, as rule
31 in tx `47448d91…8657bd`
([DEPLOYMENTS.md](DEPLOYMENTS.md#registering-the-human-signers-passkey-manual)).

### Storage

- **Long-lived secrets** live in the Stellar CLI's own store,
  `~/.config/stellar/identity/*.toml`, outside the repository. `.gitignore`
  also excludes `.env*` and `secrets/` as a backstop.
- **How the server gets them.** `packages/mcp-server/bin/barkeep-mcp` reads
  the admin and submitter secrets from that store at start and passes them as
  environment variables. It reads the shared agent key only if that identity
  exists. The Claude Code MCP registration holds only the wrapper's path.
- **Per-tab agent keys** are one mode-600 file each, named by the public key,
  in a mode-700 directory: `$BARKEEP_AGENT_KEY_DIR`, or else
  `<state dir>-agent-keys`. That directory sits next to the MCP state
  directory, not inside it.
- **The state directory holds no key material.** `src/server.test.ts` and
  `src/agentKeys.test.ts` check this against real files
  ([DEPLOYMENTS.md](DEPLOYMENTS.md#mcp-server-state)).
- **Known weakness: the MCP server process holds the admin key as well as
  the agent keys.** A compromised or buggy server could sign as the human's
  rule-0 signer, not only as a capped agent. The Arc rebuild separates the
  two: its server holds agent keys only, and an owner CLI is run by a human,
  enforced by a build test
  ([barkeep-arc SECURITY.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/SECURITY.md)).
  This has not been changed on the Stellar side.

### Rotation

- **Agent keys** rotate by construction: every new tab gets a new key.
- **Long-lived identities** are never rotated, and there is no schedule for
  it.
- **The shared agent key** (`GDUQ…D5TS`) is still a signer on the older tabs'
  rules until they are closed or expire. `close_tab` reads every rule on the
  account afterwards, and warns if that key is still a signer on another live
  rule (`packages/mcp-server/src/index.ts`).

### Destruction

- **Per-tab agent keys.** `close_tab` first removes the tab's rule on chain,
  which makes the chain refuse the key with `#3000`
  ([tx afda2b58…](https://stellar.expert/explorer/testnet/tx/afda2b58582ea1fc8a88a4cd1d6b3f037d04f2083aa1c959d84334497041e877)).
  It then overwrites the key file and removes it. If `open_tab` fails, the key
  it made is destroyed at once. A tab whose key file is gone is refused
  rather than signed with another key.
  - **Tested:** offline, by `src/agentKeys.test.ts`.
  - **Not yet tested:** a Testnet done-test showing a per-tab key paying and
    then being refused after close. It needs the Stellar CLI and the Testnet
    identities, which were not on the machine where this was written.
- **Long-lived identities.** None are destroyed. They are throwaway Testnet
  accounts funded by Friendbot and hold nothing of value. If one is lost,
  generate another and redeploy
  ([DEPLOYMENTS.md](DEPLOYMENTS.md#what-is-not-in-the-repo)).
- **Limit of the method.** Overwriting a file in place is not forensic
  erasure on a copy-on-write filesystem such as APFS, or on an SSD. Read
  "destroyed" as "the server can no longer read it". What actually ends a tab
  is the rule's removal on chain.

## Stellar mainnet

No Stellar mainnet key exists for this project, and no Stellar mainnet
transaction has been made. Mainnet stays closed until the policy review in
[ARCHITECTURE-v2.md](ARCHITECTURE-v2.md) (constraint 4, §10 risk 2) is done.
If a mainnet flow is ever run, it should follow the Arc procedure below and
record what happens to every key.

## Arc mainnet (barkeep-arc): the evidence

The run was on Arc mainnet, chain 5042, on 2026-09-24. Sources:
- [docs/MAINNET.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/MAINNET.md)
- [docs/PHASE5_PRECONDITIONS.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/PHASE5_PRECONDITIONS.md)
- the key-state check of 2026-09-25, proposed for MAINNET.md in
  [barkeep-arc#11](https://github.com/barbarosalagoz/barkeep-arc/pull/11)

### Owner key

- **Generation.** `barkeep-arc-owner keygen <name>` writes a new key to
  `~/.local/state/barkeep-arc/keys.json` (mode 600) and prints only its
  address
  ([cli.ts](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/packages/mcp-server/src/owner/cli.ts),
  [keyfile.ts](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/packages/mcp-server/src/owner/keyfile.ts)).
  The rule is to "Generate the owner key only once the exchange is ready to
  send, so that no funded-looking address sits unused".
- **Use.** Only `bin/barkeep-arc-owner` reads the key, and a human runs it.
- **Rotation in practice: one key per funding attempt.**
  - **2026-09-21:** the exchange put the withdrawal on a 48-hour hold. The key
    was read on chain (balance 0, nonce 0), then "destroyed unused".
  - **2026-09-23:** a 15-hour hold after a TRY deposit. The key was "read on
    chain first, at balance 0 and nonce 0 on chain 5042, then destroyed
    unused".
  - **2026-09-24:** a fresh key, `0xBf48c3C741aFC9FA17C0c83c57123A944B3cDFB6`,
    "generated for this and held nothing before (nonce 0, balance 0, read on
    chain first)". This key was funded.
- **After the run.**
  - The owner swept its balance back to the exchange
    ([`0x7b8d4b27…`](https://explorer.arc.io/tx/0x7b8d4b27e640c7d72c66b287951d12273ff41dfd0c44fb12f462e234bc5caa5b)).
    0.000018025 USDC of dust remains.
  - On 2026-09-25, `keys.json` no longer exists on the machine that ran the
    phase. Its directory was last modified at 17:45 (UTC+3) on 2026-09-24,
    after the sweeps.
  - No other copy of the file is recorded.

### Agent keys

- **Generation and storage.** The MCP server makes one key per tab
  (`src/agentKeys.ts`). Each key is one mode-600 file, created with
  `flag: "wx"` so it never overwrites another, in a mode-700 directory.
- **Destruction.** `destroy()` overwrites the file with 512 zero characters,
  then removes it, and `close_tab` calls it
  ([SECURITY.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/SECURITY.md)).
  Barkeep on Stellar now does the same.
- **On mainnet.**
  - "`close_tab` destroyed the demo tab's agent key". The owner then closed
    the tab, which swept 0.497 USDC back
    ([`0xa0be0731…`](https://explorer.arc.io/tx/0xa0be0731a74afeb513012204f0106caae8a85b059667c49e1e3f6e0c6b2592bb)).
  - The record says the forced refusal authorizations were "signed by agent
    keys that no longer exist".
  - On 2026-09-25, the agent-key directory on that machine is empty.
  - At block 22530627, both tabs and both agent addresses hold 0.

### Seller keys

The demo seller `0xD3fFdC8DD27F6c19A89ebdD2a9C9f983018bc5b8` and the second
seller key `0x78Dc…e614` (the outsider in A3) were named keys in `keys.json`.
The code says `keys.json` holds "the owner, and … the demo seller"
([keyfile.ts](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/packages/mcp-server/src/owner/keyfile.ts)).
- The seller swept its takings back to the owner
  ([`0xe81928c4…`](https://explorer.arc.io/tx/0xe81928c499cc2b874a9b2c19beccf7425e67b78b059a6dc7f17506c4f2bcc9be)).
- 0.00000824 USDC of dust remains.
- Their file no longer exists on the machine, as above.

### What the record holds

- `deployments/arc-mainnet.json` holds addresses, hashes, Circle's responses
  and balances.
- It holds no private key, signature or seller proof.
- CI scans every line any commit added for secrets
  ([SECURITY.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/SECURITY.md)).

## The Arc Testnet key loss, 2026-09-21

From
[barkeep-arc docs/TESTNET.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/TESTNET.md#2026-09-22-the-testnet-keys-are-lost),
stated as recorded there:

> On 2026-09-21 the Mac that held `~/.local/state/barkeep-arc` was wiped before
> its local state was copied. There is no backup.

**What was lost:**
- the Testnet deployer key `0x1a80c286cAB35b8CA58af33DDfCc7FEAE409aC57`;
- the relayer key, whose address was never recorded;
- the demo seller key `0x645DD12775906233c9A43c123372118eae0B7065`;
- the live demo tab's agent key `0x37948629603d12E2ac060eAbF1CD01AA0939e58f`;
- the MCP server's local tab and payment records.

**What it cost:**
- 0.939 USDC is stuck for good in the Testnet demo tab
  `0xc96f926A148F77da3828c051aE0ddE0fC667aD27`.
- 18.54538 USDC at the deployer and 0.436 USDC at the demo seller cannot be
  moved.
- All of it is faucet USDC. No mainnet funds were involved.

**Why it matters:**
- It is the clearest single-point-of-failure event in the project. One
  person and one machine held every key, with no backup.
- The contracts behaved as designed, and the factory has no admin, so a new
  owner key can use it. The failure was operational.
- The records do not say that a backup practice was adopted afterwards.
  Until they do, this file treats "one machine, no backup" as still true.

## Single points of failure

| Point | Effect if it fails | Today |
| --- | --- | --- |
| One person holds every key | Loss, compromise or absence stops everything | True on both chains |
| One machine holds every key, no backup | Keys are lost, as on 2026-09-21 | No backup practice is recorded, so treated as true |
| Stellar MCP server holds the admin key | A compromised server can act as the human's rule-0 signer | True. Fixed on Arc, not yet on Stellar |
| Agent key leak | Reaches one tab, up to its cap, payees and expiry | Per-tab keys since `5d0b427`. Older tabs still share one key until closed or expired |
| Passkey is the human signer | A lost authenticator loses that signer. Recovery is an open question ([ARCHITECTURE-v2.md §14](ARCHITECTURE-v2.md#14-open-questions) Q3) | Rule 0's ed25519 admin key still exists alongside it |
| Custody | Barkeep never holds user funds. On Stellar they sit in the smart account; on Arc, in the per-tab contract | The contracts are unaudited: [ARCHITECTURE-v2.md §4.1](ARCHITECTURE-v2.md#41-what-is-audited-and-what-is-not) |
