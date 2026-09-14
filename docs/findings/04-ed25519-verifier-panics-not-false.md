> DRAFT for the author's review. Facts and structure taken from the repo record on 2026-09-15; the prose is to be rewritten in his own words.

# The ed25519 verifier never returns false, so every signing mistake looks the same

**Status:** confirmed in a local `Env` and on Testnet, 2026-09-12. Written up as
an observation in the unposted upstream draft; not reported on its own.

## What I expected

`VerifierClientInterface` in `stellar-accounts` 0.7.2 declares
`verify(hash, key_data, sig_data) -> bool`. The account's `authenticate` has a
`!verify(..)` branch that returns `ExternalVerificationFailed`, contract error
3003. I expected a bad signature to come back as `false` and surface as 3003,
so a client could tell "the account rejected this signature" apart from a
trap somewhere else.

## What I observed

`verify` returns `true` or does not return. `verifiers::ed25519::verify` calls
the host's `ed25519_verify`, and the host function traps with
`Error(Crypto, InvalidInput)` on a bad signature instead of returning `false`.
Its documentation says so. The `!verify(..)` branch in `authenticate` is
therefore unreachable with this verifier, and 3003 never appears.

The same is true of the WebAuthn verifier: `secp256r1_verify` panics, and the
library's own ceremony checks panic with `WebAuthnError`.

The consequence for a client is that a wrong digest, a tampered signature and a
signature replayed from another account all read identically on chain:
`Error(Crypto, InvalidInput)` followed by `Error(Auth, InvalidAction)`. On the
`v0.9.0` branch the three cases I ran were signing the raw
`signature_payload` instead of the digest, signing the 0.7.2 digest instead of
the preimage digest, and replaying one account's signature against another.
Their diagnostic sequences were the same.

## How I measured it

Locally, in the verifier crate's tests, which run against the contract through
its generated client. `contracts/barkeep-verifier-ed25519/src/test.rs` has two
`#[should_panic(expected = "Error(Crypto, InvalidInput)")]` cases: the fixture
signature with its first byte flipped, and the fixture signature over a
different payload. The fixtures are the vectors `stellar-accounts` uses in its
own tests, so they are known-good independently of my code.

```sh
cargo test -p barkeep-verifier-ed25519
```

On chain, read-only, against the deployed 0.7.2 verifier
`CCVOYY3CQGSJV42INAUOQMBSX2OIEOX355MUWRSHAW4LEHQNF3RQR5NJ`:

```sh
./scripts/verify-verifiers-testnet.sh
```

That script simulates the known-good fixture and the flipped-byte fixture and
expects the second to be rejected with `Error(Crypto, InvalidInput)`. Its
output is not recorded in `deployments/testnet.json`.

On chain, submitted, through the account's `__check_auth` on the `4529d70`
deployment, record `deployments/testnet-v09.json`, `clientFlow`:

| Case | What was signed | Tx | Diagnostic |
| --- | --- | --- | --- |
| E3 | The raw `signature_payload` | `1bbff72b6a390a354af38298a84ca67d42bf5e19f973cb24edd9d242bcbfa210`, ledger 4644345 | `failed ED25519 verification`, `Error(Crypto, InvalidInput)`, `Error(Auth, InvalidAction)` |
| E4 | The 0.7.2 digest `sha256(payload ‖ rule_ids)` | `53de1f45f4061da865a3b856757649a10180c60e3ca5a8b0b15f3684ba911022`, ledger 4644347 | Same as E3 |
| R2 | A valid digest for account A, presented to account B | `dbeb6f62c96e00fb684be29ca6d5ea6e01993ef8ca4e9e15210987be427f0cdf`, ledger 4644359 | Same as E3 |

Each refused case was submitted with a footprint borrowed from a correctly
signed copy, so the refusal is the ledger's and not a simulation's. The same
three refusals were also caught by the second, enforcing simulation before
submission.

What was not run: a signature made with a different key over the correct
digest. The unit tests cover a tampered signature and a wrong payload; the
on-chain cases cover a wrong digest and a replay. That a wrong key traps the
same way follows from the host function's behaviour, since it has no other
failure path, but it is inferred and not measured. The on-chain cases were
also run through the `4529d70` verifier `CD3353…NNS2`, which wraps the same
library function as the 0.7.2 one; the header comment and the tests in the
two crates are identical.

## What it means for other builders

You cannot tell from the chain which of your signing mistakes you made. A
client that gets `Error(Crypto, InvalidInput)` from an account built on this
library has to work out for itself whether the digest was wrong, the key was
wrong or the signature was reused.

Two things helped me. First, pin the client's digest to the contract's: on
0.7.2 the contract test `print_auth_digest_vectors` emits vectors that
`authDigest.test.ts` asserts against, so a drift fails a test rather than a
transaction; on `4529d70` the contract has an `auth_digest` view, and
simulating it with the client's preimage is the cheapest check there is (case
E1 in the same record found that the host refuses a map whose keys are not
sorted before the view even runs). Second, always re-simulate with the signed
entries attached before submitting; the recording-mode simulation never runs
`__check_auth`, so it cannot catch any of this, but the second simulation
caught every case above.

If you are writing a verifier and want 3003 to mean something, `verify` would
have to catch the host trap, which Soroban does not offer, or check the
signature some other way first. I did not try either.

## Where it has been reported

Observation 1 in `docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md`,
the unposted draft for OpenZeppelin/stellar-contracts. It is framed there as a
documentation gap in the "Authorizing from a Client" section, which describes
the delegated failure mode but not this one, and explicitly not as a bug. It
has not been sent, and it has no issue of its own. The host function's
behaviour is documented by Soroban, so there is nothing to report on that side.

## Record

- `contracts/barkeep-verifier-ed25519/src/lib.rs`, header comment; `src/test.rs`, the two `should_panic` cases.
- `contracts/barkeep-verifier-webauthn/src/lib.rs`, header comment, for the secp256r1 equivalent.
- Commit `db87031`: "Neither verify returns false."
- `scripts/verify-verifiers-testnet.sh`: the read-only on-chain check.
- `deployments/testnet-v09.json`, `clientFlow.E3`, `E4`, `R2`: hashes and diagnostic sequences.
- `docs/upstream/stellar-contracts-v0.9.0-client-flow-testnet.md`, "Observations", item 1.
