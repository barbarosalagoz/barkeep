> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# The WebAuthn verifier passed its done-test and could never be called by the account

**Status:** confirmed by simulation on Testnet and fixed by a redeploy,
2026-09-15. Barkeep's bug, not upstream's; nothing to report.

## What I expected

`scripts/verify-verifiers-testnet.sh` had been green since the first deploy:
the WebAuthn verifier `CBZ5BMHGTQAWIGF4ACZCOHLLYSQFKCYXRV5TFWCQ5T3JYFRHEEJHF3KL`
accepted the library's known-good fixture and refused it replayed on another
payload. I took that as proof the passkey path worked on chain, short of a real
passkey to register.

## What I observed

The account could not call it. `stellar-accounts` 0.7.2 stores every signature
in `AuthPayload.signers` as `Bytes` and `authenticate` passes that `Bytes`
value to the verifier as a `Val` (`smart_account/storage.rs`, `authenticate`).
The verifier I wrote declared `verify(hash: Bytes, key_data: Bytes, sig_data:
WebAuthnSigData)`, the struct. The host will not read a `Bytes` value as a map,
so the call trapped before a single check ran:

```text
Error(WasmVm, InvalidAction)
VM call trapped: UnreachableCodeReached
```

The done-test never saw this because the Stellar CLI builds arguments from the
contract's own spec. Given a struct parameter, it takes JSON and encodes a map,
which is the one shape the account never sends. The script exercised the CLI's
calling convention and called it the account's.

The Ed25519 verifier has the same declaration style (`sig_data: BytesN<64>`)
and works, because a `Bytes` value converts to `BytesN<64>` with a length
check. Only the structured signature was affected. The `VerifierClientInterface`
the account uses takes `Val` for both `key_data` and `sig_data`, so the
mismatch was invisible at compile time.

## How I measured it

By simulating `verify` on the deployed contract twice with the same fixture,
once with the struct as an ScVal map and once with that map's XDR as one
`Bytes` value, which is what `authenticate` sends. Read-only, from the
deployer's public key; nothing submitted.

| Verifier | struct (CLI shape) | Bytes of the struct's XDR (account shape) |
| --- | --- | --- |
| `CBZ5BMHG…F3KL`, first deploy | `true` | `Error(WasmVm, InvalidAction)` |
| `CCMT5OWK…5SCV`, redeploy | `Error(WasmVm, InvalidAction)` | `true` |

The fix follows OpenZeppelin's own example at `4529d70`,
`examples/multisig-smart-account/webauthn-verifier/src/contract.rs`: take
`sig_data: Bytes` and decode it with `WebAuthnSigData::from_xdr`. Two failure
shapes come out of that, and the unit tests pin both. Bytes that are not XDR
trap in the host's deserializer with `Error(Value, InvalidInput)` before the
contract runs. Valid XDR of something other than the struct is refused with
`3120`, `SigDataNotXdr`, the one code this crate adds.

```sh
cargo test -p barkeep-verifier-webauthn
./scripts/verify-verifiers-testnet.sh
```

The redeploy: wasm upload
`e69dc811aef5fdc16ff3b9c7de46de97ac92cd14bc56e9b9dcb70409c2031168`
(ledger 4689872), create
`3c2ba0752688ece9b4bc4008fcc62499e7311ebdaf84c72c0a37301414e1ee09`
(ledger 4689873), wasm hash
`fc18303bd3bfa96afffc6453df2f5a57121a26b98c4a171e3a4e0129aa1c57bf`. No signer
was ever bound to the first contract; it stays on Testnet, referenced by
nothing.

Then the account path itself, end to end, with a throwaway passkey from a
Chromium virtual authenticator (`WebAuthn.addVirtualAuthenticator` over CDP,
the thing `ARCHITECTURE-v2.md` §13 noted and had not built). Rule 30, a
`Default` rule holding only that passkey, was added under rule 0's authority
(`e3767763e4daa61839bd6a5879139997d802bebfab4b6fde1d2c200afb40d486`). A
transfer of 1000 base units of TAB from the account to the demo seller,
authorised by nothing but the passkey's assertion on rule 30, succeeded:
`42cc207c30036cdd4cf17806dfcb8ae1a829533a6e7dedf52a6ecad0ea167026`, ledger
4689896, `successful: true` on Horizon, one `transfer` event from the token
contract. The assertion's flags byte was `0x05` (User Present, User Verified)
and its `clientDataJSON` origin `http://localhost:8001`. Rule 30 was removed
afterwards (tx in `deployments/testnet.json`, `doneTests.passkeyRehearsal`).

The human's own passkey then did the same on rule 31, with Touch ID in a
browser: `f6a66a603e160bb63e539b458acec6b6245f930d54ac8dc2918108397999ce17`,
ledger 4690054, flags `0x1d`, origin `http://localhost:8000`, the assertion
read back from the envelope on Horizon (`doneTests.passkeySign`).

## What it means for other builders

A verifier done-test has to send the bytes the account sends. Calling
`verify` through the CLI proves the contract parses the CLI's arguments, not
that `__check_auth` can reach it. Either simulate `verify` with the argument
shapes from `authenticate`, or run a signature through the account, which is
what caught this.

If your signature has structure, the verifier takes `Bytes` and decodes XDR.
The library's example does this and its doc comment says why; I read the
library and not the example.

And write the client's encoding down once. For Barkeep it is: the value in
`AuthPayload.signers` for a passkey is the XDR of
`WebAuthnSigData { signature, authenticator_data, client_data }` as one
`Bytes`, map keys in sorted order, `signature` the raw 64-byte `r || s`
normalised to low-S because `secp256r1_verify` refuses high-S. The challenge
in `clientDataJSON` is the base64url, no padding, of
`sha256(signature_payload || context_rule_ids.to_xdr())`.

## Where it has been reported

Nowhere; there is nothing to report. The library's interface is documented
and its example is correct. `contracts/barkeep-v09-verifier-webauthn` carries
the same declaration and is not changed here.

## Record

- `contracts/barkeep-verifier-webauthn/src/lib.rs`: the fix, with the header comment stating the first deployment's failure.
- `contracts/barkeep-verifier-webauthn/src/test.rs`: `raw_signature_bytes_are_not_xdr_and_trap_in_the_host`, `rejects_xdr_of_something_other_than_webauthn_sig_data`.
- `scripts/verify-verifiers-testnet.sh`: now passes the struct's XDR, plus a third case for raw bytes.
- `deployments/testnet.json`, `contracts.verifierWebAuthn`: both deployments, with `supersedes`.
- `deployments/testnet.json`, `doneTests.passkeyRehearsal`: the virtual-authenticator run.
- `packages/mcp-server/scripts/passkey-sign-testnet.mjs` and `scripts/passkey-sign.html`: the client encoding, in code.
