extern crate std;

use ed25519_dalek::{Signer as _, SigningKey};
use soroban_sdk::{Bytes, BytesN, Env, Vec};

use crate::{Ed25519Verifier, Ed25519VerifierClient};

/*
 * Fixture: a fixed secret key, so the public key, payload and signature below
 * are reproducible byte-for-byte. Same vector as stellar-accounts 0.7.2's own
 * verifiers/test/ed25519.rs, which is what makes it known-good rather than
 * self-generated and self-confirmed.
 */
const SECRET_KEY: [u8; 32] = [
    157, 97, 177, 157, 239, 253, 90, 96, 186, 132, 74, 244, 146, 236, 44, 196, 68, 73, 197, 105,
    123, 50, 105, 25, 112, 59, 172, 3, 28, 174, 127, 96,
];

struct Fixture {
    env: Env,
    client_id: soroban_sdk::Address,
    payload: Bytes,
    public_key: BytesN<32>,
    signature: BytesN<64>,
}

fn fixture() -> Fixture {
    let env = Env::default();
    let client_id = env.register(Ed25519Verifier, ());

    let signing_key = SigningKey::from_bytes(&SECRET_KEY);
    let public_key = BytesN::<32>::from_array(&env, signing_key.verifying_key().as_bytes());

    let data = Bytes::from_array(&env, &[1u8; 64]);
    let digest = env.crypto().keccak256(&data);
    let payload = Bytes::from_array(&env, &digest.to_array());
    let signature = BytesN::<64>::from_array(&env, &signing_key.sign(&digest.to_array()).to_bytes());

    Fixture { env, client_id, payload, public_key, signature }
}

#[test]
fn verifies_a_known_good_signature() {
    let f = fixture();
    let client = Ed25519VerifierClient::new(&f.env, &f.client_id);

    assert!(client.verify(&f.payload, &f.public_key, &f.signature));
}

#[test]
#[should_panic(expected = "Error(Crypto, InvalidInput)")]
fn rejects_a_tampered_signature() {
    let f = fixture();
    let client = Ed25519VerifierClient::new(&f.env, &f.client_id);

    let mut bytes = f.signature.to_array();
    bytes[0] ^= 0xff;

    client.verify(&f.payload, &f.public_key, &BytesN::<64>::from_array(&f.env, &bytes));
}

#[test]
#[should_panic(expected = "Error(Crypto, InvalidInput)")]
fn rejects_a_signature_over_a_different_payload() {
    let f = fixture();
    let client = Ed25519VerifierClient::new(&f.env, &f.client_id);

    let other = Bytes::from_array(&f.env, &[2u8; 32]);

    client.verify(&other, &f.public_key, &f.signature);
}

#[test]
fn canonicalizes_a_key_to_its_32_bytes() {
    let f = fixture();
    let client = Ed25519VerifierClient::new(&f.env, &f.client_id);

    let canonical = client.canonicalize_key(&f.public_key);

    assert_eq!(canonical, Bytes::from_array(&f.env, &f.public_key.to_array()));
}

#[test]
fn batch_canonicalize_preserves_order() {
    let f = fixture();
    let client = Ed25519VerifierClient::new(&f.env, &f.client_id);

    let a = BytesN::<32>::from_array(&f.env, &[7u8; 32]);
    let b = f.public_key.clone();
    let keys = Vec::from_array(&f.env, [a.clone(), b.clone()]);

    let canonical = client.batch_canonicalize_key(&keys);

    assert_eq!(canonical.len(), 2);
    assert_eq!(canonical.get(0).unwrap(), Bytes::from_array(&f.env, &a.to_array()));
    assert_eq!(canonical.get(1).unwrap(), Bytes::from_array(&f.env, &b.to_array()));
}

#[test]
#[ignore]
fn print_fixture_hex() {
    fn hex(b: &[u8]) -> std::string::String {
        b.iter().map(|x| std::format!("{x:02x}")).collect()
    }
    let f = fixture();
    let mut payload = [0u8; 32];
    f.payload.copy_into_slice(&mut payload);
    std::println!("ED_PAYLOAD={}", hex(&payload));
    std::println!("ED_KEY={}", hex(&f.public_key.to_array()));
    std::println!("ED_SIG={}", hex(&f.signature.to_array()));
}
