# The WebAuthn verifier passed its done-test and could never be called by the account

**Status:** confirmed by simulation on Testnet and fixed by a redeploy,
2026-09-15. Barkeep's bug, not upstream's. Nothing to report.

## What I expected

`scripts/verify-verifiers-testnet.sh` had been green since the first deploy.
It called the WebAuthn verifier
`CBZ5BMHGTQAWIGF4ACZCOHLLYSQFKCYXRV5TFWCQ5T3JYFRHEEJHF3KL` with the library's
known-good fixture and it passed. It replayed the same fixture on another
payload and got a refusal. The script was green. I read that as "the passkey
path works" and moved on. All that was missing, I thought, was a real passkey
to register.

## What I observed

The account could not call the verifier at all. `stellar-accounts` 0.7.2
stores every signature in `AuthPayload.signers` as `Bytes`. Its `authenticate`
passes that `Bytes` value to the verifier as a `Val`
(`smart_account/storage.rs`, `authenticate`). The verifier I wrote declared
`verify(hash: Bytes, key_data: Bytes, sig_data: WebAuthnSigData)`. That last
parameter is the struct. The host will not read a `Bytes` value as a map. So
the call trapped before a single check ran:

```text
Error(WasmVm, InvalidAction)
VM call trapped: UnreachableCodeReached
```

Why the done-test never saw this: the Stellar CLI builds arguments from the
contract's own spec. Given a struct parameter, it takes JSON and encodes a
map. That is the one shape the account never sends. My script was testing the
CLI's calling convention and I had been calling it the account's.

The Ed25519 verifier declares its parameter the same way, `sig_data: BytesN<64>`,
and it works. A `Bytes` value converts to `BytesN<64>` with a length check.
Only the structured signature was affected. The `VerifierClientInterface` the
account uses takes `Val` for both `key_data` and `sig_data`, so the compiler
had no way to tell me.

## How I measured it

I simulated `verify` on the deployed contract twice with the same fixture.
Once with the struct as an ScVal map, the CLI's shape. Once with that map's
XDR as one `Bytes` value, which is what `authenticate` sends. Both read-only,
from the deployer's public key. Nothing submitted.

| Verifier | struct (CLI shape) | Bytes of the struct's XDR (account shape) |
| --- | --- | --- |
| `CBZ5BMHG…F3KL`, first deploy | `true` | `Error(WasmVm, InvalidAction)` |
| `CCMT5OWK…5SCV`, redeploy | `Error(WasmVm, InvalidAction)` | `true` |

The fix follows OpenZeppelin's own example at `4529d70`,
`examples/multisig-smart-account/webauthn-verifier/src/contract.rs`. I changed
the function to take `sig_data: Bytes` and decode it with
`WebAuthnSigData::from_xdr`. That leaves two failure shapes, and I pinned both
in the unit tests. Bytes that are not XDR trap in the host's deserializer with
`Error(Value, InvalidInput)` before the contract runs. Valid XDR of something
other than the struct is refused with `3120`, `SigDataNotXdr`. That is the one
code this crate adds.

```sh
cargo test -p barkeep-verifier-webauthn
./scripts/verify-verifiers-testnet.sh
```

Then I redeployed. Wasm upload
`e69dc811aef5fdc16ff3b9c7de46de97ac92cd14bc56e9b9dcb70409c2031168`
(ledger 4689872). Create
`3c2ba0752688ece9b4bc4008fcc62499e7311ebdaf84c72c0a37301414e1ee09`
(ledger 4689873). Wasm hash
`fc18303bd3bfa96afffc6453df2f5a57121a26b98c4a171e3a4e0129aa1c57bf`. No signer
was ever bound to the first contract. It stays on Testnet, referenced by
nothing.

Then I ran the account path itself, end to end, with a throwaway passkey. A
Chromium virtual authenticator made it (`WebAuthn.addVirtualAuthenticator`
over CDP, the thing `ARCHITECTURE-v2.md` §13 noted and I had not built). I
added rule 30, a `Default` rule holding only that passkey, under rule 0's
authority (`e3767763e4daa61839bd6a5879139997d802bebfab4b6fde1d2c200afb40d486`).
I sent a transfer of 1000 base units of TAB from the account to the demo
seller, authorised by nothing but the passkey's assertion on rule 30. It
succeeded: `42cc207c30036cdd4cf17806dfcb8ae1a829533a6e7dedf52a6ecad0ea167026`,
ledger 4689896, `successful: true` on Horizon, one `transfer` event from the
token contract. The assertion's flags byte was `0x05` (User Present, User
Verified). Its `clientDataJSON` origin was `http://localhost:8001`. I removed
rule 30 afterwards (tx in `deployments/testnet.json`,
`doneTests.passkeyRehearsal`).

Then my own passkey did the same on rule 31, with Touch ID in a browser:
`f6a66a603e160bb63e539b458acec6b6245f930d54ac8dc2918108397999ce17`, ledger
4690054, flags `0x1d`, origin `http://localhost:8000`. I read the assertion
back from the envelope on Horizon (`doneTests.passkeySign`).

## What it means for other builders

A verifier done-test has to send the bytes the account sends. Calling `verify`
through the CLI proves the contract parses the CLI's arguments. It does not
prove `__check_auth` can reach it. Either simulate `verify` with the argument
shapes from `authenticate`, or run a signature through the account. The second
is what caught this.

If your signature has structure, the verifier takes `Bytes` and decodes XDR.
The library's example does this and its doc comment says why. I read the
library and skipped the example.

And write the client's encoding down once. For Barkeep it is this. The value
in `AuthPayload.signers` for a passkey is the XDR of
`WebAuthnSigData { signature, authenticator_data, client_data }` as one
`Bytes`, map keys in sorted order. `signature` is the raw 64-byte `r || s`,
normalised to low-S because `secp256r1_verify` refuses high-S. The challenge
in `clientDataJSON` is the base64url, no padding, of
`sha256(signature_payload || context_rule_ids.to_xdr())`.

## Where it has been reported

Nowhere. There is nothing to report. The library's interface is documented and
its example is correct. `contracts/barkeep-v09-verifier-webauthn` carries the
same declaration and is not changed here.

## Record

- `contracts/barkeep-verifier-webauthn/src/lib.rs`: the fix, with the header comment stating the first deployment's failure.
- `contracts/barkeep-verifier-webauthn/src/test.rs`: `raw_signature_bytes_are_not_xdr_and_trap_in_the_host`, `rejects_xdr_of_something_other_than_webauthn_sig_data`.
- `scripts/verify-verifiers-testnet.sh`: now passes the struct's XDR, plus a third case for raw bytes.
- `deployments/testnet.json`, `contracts.verifierWebAuthn`: both deployments, with `supersedes`.
- `deployments/testnet.json`, `doneTests.passkeyRehearsal`: the virtual-authenticator run.
- `packages/mcp-server/scripts/passkey-sign-testnet.mjs` and `scripts/passkey-sign.html`: the client encoding, in code.
