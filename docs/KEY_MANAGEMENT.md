# Key management

How Barkeep's keys are generated, stored, rotated and destroyed. It covers the
Stellar Testnet deployment in this repository, the Arc mainnet run in
[barbarosalagoz/barkeep-arc](https://github.com/barbarosalagoz/barkeep-arc)
(the only record anywhere in this project that involves real funds), and the
loss of the Arc Testnet keys.

Everything below is taken from the repositories' own records. The Arc
references are pinned to commit
[`5c211a5`](https://github.com/barbarosalagoz/barkeep-arc/tree/5c211a5).
**[BARBAROS: CONFIRM]** marks a question the records do not answer.

## Summary

| Key | Chain | Generated | Stored | Rotated | Destroyed |
| --- | --- | --- | --- | --- | --- |
| Deployer / submitter | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No; a throwaway Testnet account |
| Admin (rule-0 signer) | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Agent session key | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | **Never. One key serves every tab** | No. `close_tab` revokes the tab's rule on chain; the key itself survives |
| Facilitator fee payer | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Demo seller | Stellar Testnet | `stellar keys generate` | Stellar CLI key store | Never | No |
| Human signer passkey | Stellar Testnet | Inside the authenticator (WebAuthn) | Inside the authenticator; never leaves it | — | **[BARBAROS: CONFIRM]** whether that passkey still exists |
| Any key | **Stellar mainnet** | **None exists** | — | — | — |
| Owner | Arc mainnet | `barkeep-arc-owner keygen`, fresh per funding attempt | Mode-600 key file | A new one for each attempt | Two unused keys destroyed. **The funded key: not recorded** |
| Agent, per tab | Arc mainnet | Made by the MCP server when a tab opens | One mode-600 file per tab, in a mode-700 directory | One key per tab | Yes, by `close_tab` (overwrite, then remove) |
| Demo seller, second seller | Arc mainnet | **[BARBAROS: CONFIRM]** | **[BARBAROS: CONFIRM]** | — | **Not recorded** |
| Deployer, relayer, seller, demo agent | Arc Testnet | As above | `~/.local/state/barkeep-arc` on a Mac | — | **Lost** on 2026-09-21 (see below) |

## Stellar Testnet (this repository)

### Generation

Keys are Stellar CLI identities made with `stellar keys generate … --network
testnet --fund` and funded by Friendbot
([DEPLOYMENTS.md](DEPLOYMENTS.md#what-is-not-in-the-repo)). The public keys are
listed there:

- `barkeep-testnet-deployer`
- `barkeep-testnet-admin`
- `barkeep-testnet-agent`
- `barkeep-testnet-facilitator`
- `barkeep-testnet-seller`

A few done-tests also used fresh Friendbot accounts that were created only
for that run, for example the x402 spike's T0 payer and the payee-allowlist
test's listed and unlisted payees (`deployments/testnet.json`).

The human signer's passkey is created in the browser with
`navigator.credentials.create()` (`scripts/passkey-register.html`). The
private key is generated inside the authenticator and never leaves it. Only
the public key and the credential id are registered on the account, as rule
31 in tx `47448d91…8657bd`
([DEPLOYMENTS.md](DEPLOYMENTS.md#registering-the-human-signers-passkey-manual)).

### Storage

- Secrets live in the Stellar CLI's own store,
  `~/.config/stellar/identity/*.toml`, which is outside the repository.
  `.gitignore` also excludes `.env*` and `secrets/` as a backstop.
- `packages/mcp-server/bin/barkeep-mcp` reads the admin, agent and deployer
  secrets from that store each time the server starts, and passes them as
  environment variables. The Claude Code MCP registration holds only the
  wrapper's path.
- The MCP server's state directory holds no key material.
  `src/server.test.ts` checks this against the real files
  ([DEPLOYMENTS.md](DEPLOYMENTS.md#mcp-server-state)).
- **Known weakness: the MCP server process holds the admin key alongside the
  agent key.** A compromised or buggy server could therefore sign as the
  human's rule-0 signer, not only as the capped agent. The Arc rebuild
  separates the two for this reason. It has a server with agent keys only,
  and an owner CLI a human runs, enforced by a build test
  ([barkeep-arc SECURITY.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/SECURITY.md)).
  The Stellar side has not been changed yet.

### Rotation

There is none, and no schedule for it. In particular, a single agent session
key (`barkeep-testnet-agent`, `GDUQ…D5TS`) is the signer on every tab opened
so far. A leak of that key reaches every open tab, up to each tab's cap and
payee list. What limits it is on chain:

- each tab has its own cap, payee list and expiry;
- `close_tab` removes the rule, and a transfer after close is refused with
  `#3000`
  ([tx afda2b58…](https://stellar.expert/explorer/testnet/tx/afda2b58582ea1fc8a88a4cd1d6b3f037d04f2083aa1c959d84334497041e877)).

Because the key is shared, `close_tab` reads every rule on the account
afterwards. It warns if the agent key is still a signer on another live rule
(`packages/mcp-server/src/index.ts`).

Per-tab session keys are the fix. They are not built.

### Destruction

None. These are throwaway Testnet accounts funded by Friendbot, and they hold
nothing of value. If one is lost, the procedure is to generate another and
redeploy ([DEPLOYMENTS.md](DEPLOYMENTS.md#what-is-not-in-the-repo)).

**[BARBAROS: CONFIRM]** whether you want the workshop kit to generate one
session key per tab and delete it on `close_tab`, as Arc does. That would
make this section's answer "yes" for agent keys.

## Stellar mainnet

No Stellar mainnet key exists for this project, and no Stellar mainnet
transaction has been made. Mainnet stays closed until the policy review in
[ARCHITECTURE-v2.md](ARCHITECTURE-v2.md) (constraint 4, §10 risk 2) is done.
If a mainnet flow is ever run, it should follow the Arc procedure below and
record what happens to **every** key, including the funded owner key, which
the Arc record leaves out.

## Arc mainnet (barkeep-arc): the evidence

Arc mainnet, chain 5042, 2026-09-24. Source:
[docs/MAINNET.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/MAINNET.md)
and
[docs/PHASE5_PRECONDITIONS.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/PHASE5_PRECONDITIONS.md).

### Owner key

- **Generation.** `barkeep-arc-owner keygen <name>` writes a new key to the
  owner key file and prints only its address
  ([packages/mcp-server/src/owner/cli.ts](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/packages/mcp-server/src/owner/cli.ts)).
  The rule is to "Generate the owner key only once the exchange is ready to
  send, so that no funded-looking address sits unused".
- **Storage.** `~/.local/state/barkeep-arc/keys.json`, a mode-600 file read only
  by `src/owner/keyfile.ts`, and used only by a CLI a human runs
  ([packages/mcp-server/README.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/packages/mcp-server/README.md)).
- **Rotation, in practice.** There was one key per funding attempt:
  - **2026-09-21:** the exchange put the withdrawal on a 48-hour hold. The
    key was read on chain (balance 0, nonce 0) and "destroyed unused".
  - **2026-09-23:** a 15-hour hold after a TRY deposit. The key was "read on
    chain first, at balance 0 and nonce 0 on chain 5042, then destroyed
    unused".
  - **2026-09-24:** a fresh key, `0xBf48c3C741aFC9FA17C0c83c57123A944B3cDFB6`.
    It was "generated for this and held nothing before (nonce 0, balance 0,
    read on chain first)", then funded.
- **After the run.** The owner swept its balance back to the exchange
  ([`0x7b8d4b27…`](https://explorer.arc.io/tx/0x7b8d4b27e640c7d72c66b287951d12273ff41dfd0c44fb12f462e234bc5caa5b)).
  0.000018025 USDC of dust remains at block 22530627.
  **The record does not say whether the funded owner key was then destroyed
  or kept.** [BARBAROS: CONFIRM, and add one line to barkeep-arc MAINNET.md.]

### Agent keys

- **Generation and storage.** The MCP server makes one key per tab
  (`src/agentKeys.ts`) and stores it as one mode-600 file in a mode-700
  directory. The file is created with `flag: "wx"`, so an existing key is
  never overwritten.
- **Destruction.** `destroy()` overwrites the file with 512 zero characters,
  then removes it. `close_tab` calls it
  ([SECURITY.md](https://github.com/barbarosalagoz/barkeep-arc/blob/5c211a5/docs/SECURITY.md)).
- **On mainnet.** "`close_tab` destroyed the demo tab's agent key". The owner
  then closed the tab and swept 0.497 USDC back in
  [`0xa0be0731…`](https://explorer.arc.io/tx/0xa0be0731a74afeb513012204f0106caae8a85b059667c49e1e3f6e0c6b2592bb).
  The record also says the forced refusal authorizations were "signed by
  agent keys that no longer exist". At block 22530627 both tabs and both
  agent addresses hold 0.
- **Limit of the method.** Overwriting a file in place does not guarantee the
  old bytes are gone on a copy-on-write filesystem such as APFS, or on an SSD.
  Treat `destroy()` as "the server can no longer read it", not as forensic
  erasure. What actually ends the tab is the owner's on-chain `close`.

### Seller keys

The demo seller `0xD3fFdC8DD27F6c19A89ebdD2a9C9f983018bc5b8` and the
"owner's second seller key" `0x78Dc…e614`, used as the outsider in A3, are
both held by the owner. The seller swept its takings back to the owner
([`0xe81928c4…`](https://explorer.arc.io/tx/0xe81928c499cc2b874a9b2c19beccf7425e67b78b059a6dc7f17506c4f2bcc9be)),
and 0.00000824 USDC of dust remains. **Whether these keys were destroyed is
not recorded.** [BARBAROS: CONFIRM]

### What the record holds

`deployments/arc-mainnet.json` holds addresses, hashes, Circle's responses
and balances. It holds no private key, signature or seller proof. CI runs a
secret scan over every line any commit added
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

**Why it matters here:** it is the clearest single point of failure in the
project so far. One person and one machine held every key, with no backup.
The contracts behaved as designed. The factory has no admin, so a new owner
key can use it. The loss was operational.

**What changed afterwards: [BARBAROS: CONFIRM].** The records do not say
whether keys are now backed up, where, or how a backup is protected. State it
here, even if the answer is "nothing yet".

## Single points of failure

| Point | Effect if it fails | Today |
| --- | --- | --- |
| One person holds every key | Loss, compromise or absence stops everything | True on both chains |
| One machine holds every key, no backup | Keys are lost, as happened on 2026-09-21 | **[BARBAROS: CONFIRM]** whether this is still true |
| Stellar MCP server holds the admin key | A compromised server can act as the human's rule-0 signer | True; Arc fixed this, Stellar has not |
| One Stellar agent key for all tabs | A leak reaches every open tab, up to each tab's cap and payees | True |
| Passkey is the human signer | A lost authenticator loses that signer; recovery is an open question ([ARCHITECTURE-v2.md §14](ARCHITECTURE-v2.md#14-open-questions) Q3) | Rule 0's ed25519 admin key still exists alongside it |
| Custody | Barkeep never holds user funds. On Stellar the funds sit in the smart account; on Arc, in the per-tab contract | Unaudited contracts: [ARCHITECTURE-v2.md §4.1](ARCHITECTURE-v2.md#41-what-is-audited-and-what-is-not) |
