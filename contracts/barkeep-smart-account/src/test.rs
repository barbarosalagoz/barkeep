extern crate std;

use soroban_sdk::{xdr::ToXdr, Bytes, Env, Vec};

/*
 * The auth digest is the one piece of the protocol a client must reproduce
 * byte-for-byte, and stellar-accounts ships no client-side helper for it
 * (ARCHITECTURE-v2 §14 q5). These tests pin the construction from the contract
 * side; packages/mcp-server/src/authDigest.test.ts asserts the TypeScript
 * builder produces the same bytes for the same inputs. If either side drifts,
 * one of the two fails.
 *
 *   auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())
 *
 * Binding the rule ids into the digest is what stops a signature gathered for
 * one context rule being replayed to select a laxer one.
 */

fn hex(b: &[u8]) -> std::string::String {
    b.iter().map(|x| std::format!("{x:02x}")).collect()
}

fn digest_hex(env: &Env, payload: &[u8; 32], rule_ids: &[u32]) -> std::string::String {
    let ids = Vec::from_slice(env, rule_ids);
    let mut preimage = Bytes::from_array(env, payload);

    preimage.append(&ids.to_xdr(env));

    hex(&env.crypto().sha256(&preimage).to_array())
}

fn bytes_hex(b: &soroban_sdk::Bytes) -> std::string::String {
    let mut out = std::vec::Vec::new();
    for i in 0..b.len() {
        out.push(b.get(i).unwrap());
    }
    hex(&out)
}

#[test]
fn context_rule_ids_encode_as_an_scval_vec_of_u32() {
    let e = Env::default();

    assert_eq!(
        bytes_hex(&Vec::from_slice(&e, &[1u32, 2u32]).to_xdr(&e)),
        "00000010000000010000000200000003000000010000000300000002"
    );
    assert_eq!(bytes_hex(&Vec::<u32>::from_slice(&e, &[]).to_xdr(&e)), "000000100000000100000000");
}

#[test]
#[ignore]
fn print_auth_digest_vectors() {
    let e = Env::default();
    let payload_a = [0u8; 32];
    let mut payload_b = [0u8; 32];
    for (i, b) in payload_b.iter_mut().enumerate() {
        *b = i as u8;
    }

    std::println!("VEC_EMPTY={}", bytes_hex(&Vec::<u32>::from_slice(&e, &[]).to_xdr(&e)));
    std::println!("VEC_1_2={}", bytes_hex(&Vec::from_slice(&e, &[1u32, 2u32]).to_xdr(&e)));
    std::println!("DIGEST_ZERO_RULE0={}", digest_hex(&e, &payload_a, &[0]));
    std::println!("DIGEST_SEQ_RULE1={}", digest_hex(&e, &payload_b, &[1]));
    std::println!("DIGEST_SEQ_RULE_1_2={}", digest_hex(&e, &payload_b, &[1, 2]));
    std::println!("DIGEST_SEQ_NORULES={}", digest_hex(&e, &payload_b, &[]));
}
