extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    xdr::{ScVal, ToXdr},
    Address, Bytes, BytesN, Env, IntoVal, String, TryFromVal, Val, Vec,
};
use stellar_accounts::smart_account::{AuthDigestPreimage, Signer};

use crate::{BarkeepSmartAccount, BarkeepSmartAccountClient};

/*
 * At 4529d70 a client must reproduce
 *
 *   auth_digest = sha256(AuthDigestPreimage { account, signature_payload,
 *                                             context_rule_ids }.to_xdr())
 *
 * byte-for-byte. These tests pin it from the contract side, and
 * print_auth_digest_preimage_vectors emits the vectors that
 * packages/mcp-server/src/authDigestPreimage.test.ts asserts, so the Rust and
 * TypeScript implementations check each other. The deployed account's
 * auth_digest view is the third check, by simulation on Testnet.
 */

/// The 0.7.2 account's id: any valid contract address serves, and a real one
/// is as good as a made-up one.
const ACCOUNT_A: &str = "CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH";
/// The 0.7.2 policy's id, used only as a second, distinct account address.
const ACCOUNT_B: &str = "CBEILTNYZEE5KX6WTSRON3FCXE7KBYAAUVUWY7TWEUBIEHIY47NVPWBZ";

fn hex(b: &[u8]) -> std::string::String {
    b.iter().map(|x| std::format!("{x:02x}")).collect()
}

fn bytes_hex(b: &Bytes) -> std::string::String {
    hex(&b.iter().collect::<std::vec::Vec<u8>>())
}

fn seq_payload(e: &Env) -> BytesN<32> {
    let mut p = [0u8; 32];
    for (i, b) in p.iter_mut().enumerate() {
        *b = i as u8;
    }
    BytesN::from_array(e, &p)
}

fn preimage(e: &Env, account: &str, payload: BytesN<32>, rule_ids: &[u32]) -> AuthDigestPreimage {
    AuthDigestPreimage {
        account: Address::from_str(e, account),
        signature_payload: payload,
        context_rule_ids: Vec::from_slice(e, rule_ids),
    }
}

#[test]
fn preimage_encodes_as_a_map_with_sorted_symbol_keys() {
    let e = Env::default();
    let p = preimage(&e, ACCOUNT_A, seq_payload(&e), &[1]);

    let val: Val = p.into_val(&e);
    let ScVal::Map(Some(map)) = ScVal::try_from_val(&e, &val).unwrap() else {
        panic!("AuthDigestPreimage must encode as an ScVal map");
    };
    let keys: std::vec::Vec<std::string::String> = map
        .iter()
        .map(|entry| match &entry.key {
            ScVal::Symbol(s) => s.to_utf8_string().unwrap(),
            other => panic!("non-symbol key {other:?}"),
        })
        .collect();

    // Sorted, which is NOT the declaration order (account, signature_payload,
    // context_rule_ids).
    assert_eq!(keys, ["account", "context_rule_ids", "signature_payload"]);
}

#[test]
fn digest_is_sha256_of_the_preimage_xdr_and_matches_the_view() {
    let e = Env::default();
    let id = e.register(
        BarkeepSmartAccount,
        (Signer::Delegated(Address::generate(&e)), String::from_str(&e, "admin")),
    );
    let client = BarkeepSmartAccountClient::new(&e, &id);

    let p = preimage(&e, ACCOUNT_A, seq_payload(&e), &[1, 2]);
    let expected = e.crypto().sha256(&p.clone().to_xdr(&e)).to_bytes();

    assert_eq!(p.digest(&e), expected);
    assert_eq!(client.auth_digest(&p), expected);
}

#[test]
fn digest_differs_between_accounts_for_the_same_payload_and_rules() {
    let e = Env::default();

    // The property 0.7.2 lacked (ARCHITECTURE-v2 §10 risk 13): identical
    // signature_payload and rule selection, different account, different digest.
    let a = preimage(&e, ACCOUNT_A, seq_payload(&e), &[1]).digest(&e);
    let b = preimage(&e, ACCOUNT_B, seq_payload(&e), &[1]).digest(&e);

    assert_ne!(a, b);
}

#[test]
#[ignore]
fn print_auth_digest_preimage_vectors() {
    let e = Env::default();
    let zero = BytesN::from_array(&e, &[0u8; 32]);

    let cases: [(&str, &str, BytesN<32>, &[u32]); 4] = [
        ("A_ZERO_RULE0", ACCOUNT_A, zero, &[0]),
        ("A_SEQ_RULE1", ACCOUNT_A, seq_payload(&e), &[1]),
        ("A_SEQ_RULE_1_2", ACCOUNT_A, seq_payload(&e), &[1, 2]),
        ("B_SEQ_RULE1", ACCOUNT_B, seq_payload(&e), &[1]),
    ];

    for (label, account, payload, rules) in cases {
        let p = preimage(&e, account, payload, rules);
        std::println!("{label}_XDR={}", bytes_hex(&p.clone().to_xdr(&e)));
        std::println!("{label}_DIGEST={}", hex(&p.digest(&e).to_array()));
    }
}
