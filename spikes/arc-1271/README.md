# Spike: an ERC-1271 payer through x402 on Arc Testnet

Throwaway. One question, asked before committing to an Arc backend: will an x402
facilitator on Arc settle a payment whose `from` is a contract? On Stellar the
public facilitator would not. Testnet only, faucet USDC, nothing on mainnet.

Results, with every transaction hash, are in `deployments/arc-testnet.json`
(`transactions` and `doneTests`). The verbatim facilitator responses are in
`circle-log.jsonl` and `local-log.jsonl`.

| File | What it is |
|---|---|
| `contracts/Throwaway1271.sol` | One owner; `isValidSignature` accepts the owner's 65-byte signature over the digest. |
| `contracts/Wrapped1271.sol` | Same, but the signature is 97 bytes (owner signature + a tag). The shape a real tab contract needs. |
| `presim.mjs` | Costs nothing: `eth_call` with the contract's code overlaid, to see whether Arc's USDC honours ERC-1271 at all. |
| `deploy.mjs` | Deploys, funds the contract and the relayer, checks owner passes and a stranger fails. |
| `seller.mjs` | Minimal x402 seller: EVM `exact`, USDC `0x3600…`, `extra {name:"USDC", version:"2"}`. `SPIKE_FACILITATOR=circle\|local`. |
| `circle.mjs` | Circle's Facilitator Service on the keyless trial (`Facilitator-Seller-Proof`). |
| `facilitator.mjs` | The stock `@x402/evm` facilitator, unmodified, on Arc Testnet. |
| `pay.mjs` | The stock x402 client. Only the signer is ours: its address is the contract, the owner key signs. |
| `refusal.mjs` | Negative control: the same payment signed by a stranger, `/verify` only. |
| `wrapped.mjs` | The 97-byte case against either facilitator. |
| `trial.mjs` | Settles 0.001 USDC payments through Circle until the trial says stop, or a ceiling. |
| `record.mjs` | Reads a settlement back from the chain before recording it. |

Keys are three throwaway Testnet keys in `~/.local/state/barkeep/arc-testnet-keys.json`,
outside the repository. Node 22. `npm install` here; this folder is not a workspace.

The faucet (`faucet.circle.com`) sits behind a reCAPTCHA, so the one drip to the
owner key is done by hand.
