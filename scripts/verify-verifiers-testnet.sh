#!/usr/bin/env bash
#
# Done-test for the deployed verifier contracts (ARCHITECTURE-v2 §4, item 5).
#
# Proves, against the contracts actually on Testnet rather than a local Env,
# that each verifier accepts a known-good signature fixture and rejects a bad
# one. Read-only: every call is a simulation, so it costs nothing and needs no
# funded account beyond an identity to sign the envelope.
#
#   ./scripts/verify-verifiers-testnet.sh [stellar-cli-identity]
#
# The fixtures below are byte-for-byte reproducible. Both are the same vectors
# stellar-accounts 0.7.2 uses in its own verifiers/test/{ed25519,webauthn}.rs,
# which is what makes them known-good rather than generated and confirmed by
# the same code under test. Regenerate them with:
#
#   cargo test -p barkeep-verifier-ed25519  print_fixture_hex -- --ignored --nocapture
#   cargo test -p barkeep-verifier-webauthn print_fixture_hex -- --ignored --nocapture
set -euo pipefail

SOURCE="${1:-barkeep-testnet-deployer}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

id_of() { python3 -c "import json,sys;print(json.load(open('$HERE/deployments/testnet.json'))['contracts']['$1']['id'])"; }

ED_ID="$(id_of verifierEd25519)"
WA_ID="$(id_of verifierWebAuthn)"

ED_PAYLOAD=401617bc4f769381f86be40df0207a0a3e31ae0839497a5ac6d4252dfc35577f
ED_KEY=d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a
ED_SIG=2cc5f488297d29a803f1959b2cd12f162964b674d8f215d9649d04a97acc378d2ba1fe59a335a63544da8228a69d852d31b18cf1497269d248b479a1bdb89709
# Same signature with the first byte flipped.
ED_SIG_BAD=d3c5f488297d29a803f1959b2cd12f162964b674d8f215d9649d04a97acc378d2ba1fe59a335a63544da8228a69d852d31b18cf1497269d248b479a1bdb89709

WA_PAYLOAD=8c0cc17a04942cc4f8e0fe0b302606d3108860c126428ba2ceeb5f9ed41c2b05
WA_KEY=041f140146bfb1b251f84f4ddbe0d4cdcfd77afd984a9520e35794021f8312bb9eec995a08b1fa7704df3dcc0b50a9665263fb7711f95f9f8a449c5096e47c892b
# sig_data is the XDR of a WebAuthnSigData, as the account passes it (one Bytes
# value), not the struct: the first deployment took the struct and could only
# be called by this CLI, never by the account (docs/findings/06).
WA_SIGDATA_XDR=0000001100000001000000030000000f0000001261757468656e74696361746f725f6461746100000000000d0000002500000000000000000000000000000000000000000000000000000000000000001d000000000000000000000f0000000b636c69656e745f64617461000000000d000000847b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a226a417a42656753554c4d54343450344c4d43594730784349594d456d516f75697a7574666e7451634b7755222c226f726967696e223a2268747470733a2f2f6578616d706c652e636f6d222c2263726f73734f726967696e223a66616c73657d0000000f000000097369676e61747572650000000000000d000000405c546db1351ebcb390dcf7fe2f178f6b4a7ac56a58e0a0e4a23d7a1ca0bf2dd609e13b4a8ebfbe3cc3ee9cd52fa2985ca5ed4302a37009baddf42148fe7afcc1
# The raw 64-byte signature alone: what a client pastes when it forgets the struct.
WA_SIG_RAW=5c546db1351ebcb390dcf7fe2f178f6b4a7ac56a58e0a0e4a23d7a1ca0bf2dd609e13b4a8ebfbe3cc3ee9cd52fa2985ca5ed4302a37009baddf42148fe7afcc1
# A payload the assertion was not signed over, so the challenge no longer matches.
WA_PAYLOAD_OTHER=0303030303030303030303030303030303030303030303030303030303030303

invoke() { stellar contract invoke --id "$1" --source "$SOURCE" --network testnet -- "${@:2}" 2>&1; }

pass=0
fail=0

expect_true() {
  local label="$1"; shift
  if [[ "$("$@" | tail -1)" == "true" ]]; then
    echo "  PASS  $label"; pass=$((pass + 1))
  else
    echo "  FAIL  $label (expected true)"; fail=$((fail + 1))
  fi
}

expect_rejected() {
  local label="$1" want="$2"; shift 2
  local out; out="$("$@" || true)"
  if grep -q "$want" <<<"$out"; then
    echo "  PASS  $label (rejected with $want)"; pass=$((pass + 1))
  else
    echo "  FAIL  $label (expected rejection matching $want)"; fail=$((fail + 1))
  fi
}

echo "Ed25519 verifier $ED_ID"
expect_true "known-good signature verifies" \
  invoke "$ED_ID" verify --hash "$ED_PAYLOAD" --key_data "$ED_KEY" --sig_data "$ED_SIG"
expect_rejected "tampered signature is refused" "Error(Crypto, InvalidInput)" \
  invoke "$ED_ID" verify --hash "$ED_PAYLOAD" --key_data "$ED_KEY" --sig_data "$ED_SIG_BAD"

echo "WebAuthn verifier $WA_ID"
expect_true "known-good passkey assertion verifies" \
  invoke "$WA_ID" verify --hash "$WA_PAYLOAD" --key_data "$WA_KEY" --sig_data "$WA_SIGDATA_XDR"
# 3114 is WebAuthnError::ChallengeInvalid: the assertion is bound to one payload.
expect_rejected "assertion replayed on another payload is refused" "Error(Contract, #3114)" \
  invoke "$WA_ID" verify --hash "$WA_PAYLOAD_OTHER" --key_data "$WA_KEY" --sig_data "$WA_SIGDATA_XDR"
# Not XDR at all: the host's deserializer traps before the contract runs.
expect_rejected "raw signature bytes in place of the struct's XDR are refused" "Error(Value, InvalidInput)" \
  invoke "$WA_ID" verify --hash "$WA_PAYLOAD" --key_data "$WA_KEY" --sig_data "$WA_SIG_RAW"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
