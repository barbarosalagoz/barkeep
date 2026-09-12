extern crate std;

use p256::{
    ecdsa::{
        signature::hazmat::PrehashSigner, Signature as Secp256r1Signature,
        SigningKey as Secp256r1SigningKey,
    },
    elliptic_curve::sec1::ToEncodedPoint,
    SecretKey as Secp256r1SecretKey,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, Vec};
use stellar_accounts::verifiers::{
    utils::base64_url_encode,
    webauthn::{
        WebAuthnSigData, AUTH_DATA_FLAGS_BE, AUTH_DATA_FLAGS_BS, AUTH_DATA_FLAGS_UP,
        AUTH_DATA_FLAGS_UV,
    },
};

use crate::{WebAuthnVerifier, WebAuthnVerifierClient};

/*
 * Fixture: a fixed secp256r1 secret key, so the public key and signature are
 * reproducible. Same vector as stellar-accounts 0.7.2's own
 * verifiers/test/webauthn.rs, which is what makes it known-good rather than
 * generated and confirmed by the same code path.
 */
const SECRET_KEY: [u8; 32] = [
    33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56,
    57, 58, 59, 60, 61, 62, 63, 64,
];

/// Flags of a real passkey assertion: user present, user verified, backed up.
const GOOD_FLAGS: u8 = AUTH_DATA_FLAGS_UP | AUTH_DATA_FLAGS_UV | AUTH_DATA_FLAGS_BE | AUTH_DATA_FLAGS_BS;

struct Fixture {
    env: Env,
    client_id: Address,
    payload: Bytes,
    key_data: Bytes,
    public_key: BytesN<65>,
    sig_data: WebAuthnSigData,
}

fn authenticator_data(env: &Env, flags: u8) -> Bytes {
    let mut data = [0u8; 37];
    data[32] = flags;
    Bytes::from_array(env, &data)
}

/// clientDataJSON as a browser would send it, with the challenge bound to the
/// signature payload (base64url of the 32-byte hash, per WebAuthn step 12).
fn client_data(env: &Env, payload: &[u8; 32], type_field: &str) -> Bytes {
    let mut challenge = [0u8; 43];
    base64_url_encode(&mut challenge, payload);
    let challenge = core::str::from_utf8(&challenge).unwrap();

    let json = std::format!(
        r#"{{"type":"{type_field}","challenge":"{challenge}","origin":"https://example.com","crossOrigin":false}}"#
    );

    Bytes::from_slice(env, json.as_bytes())
}

fn fixture_with(flags: u8, type_field: &str) -> Fixture {
    let env = Env::default();
    let client_id = env.register(WebAuthnVerifier, ());

    let secret_key = Secp256r1SecretKey::from_slice(&SECRET_KEY).unwrap();
    let signing_key = Secp256r1SigningKey::from(&secret_key);

    let mut point = [0u8; 65];
    point.copy_from_slice(&secret_key.public_key().to_encoded_point(false).to_bytes());
    let public_key = BytesN::<65>::from_array(&env, &point);

    // The payload the account asks the passkey to sign.
    let payload_bytes = env.crypto().sha256(&Bytes::from_array(&env, &[9u8; 32])).to_array();
    let payload = Bytes::from_array(&env, &payload_bytes);

    let authenticator_data = authenticator_data(&env, flags);
    let client_data = client_data(&env, &payload_bytes, type_field);

    /*
     * WebAuthn steps 19-20: the signed message is
     * authenticatorData || sha256(clientDataJSON), and secp256r1_verify takes
     * the sha256 of that.
     */
    let mut message = authenticator_data.clone();
    message.extend_from_array(&env.crypto().sha256(&client_data).to_array());
    let digest = env.crypto().sha256(&message);

    let signature: Secp256r1Signature = signing_key.sign_prehash(&digest.to_array()).unwrap();
    let mut sig = [0u8; 64];
    sig.copy_from_slice(&signature.normalize_s().unwrap_or(signature).to_bytes());

    Fixture {
        key_data: Bytes::from_array(&env, &point),
        sig_data: WebAuthnSigData {
            signature: BytesN::<64>::from_array(&env, &sig),
            authenticator_data,
            client_data,
        },
        env,
        client_id,
        payload,
        public_key,
    }
}

fn fixture() -> Fixture {
    fixture_with(GOOD_FLAGS, "webauthn.get")
}

#[test]
fn verifies_a_known_good_passkey_assertion() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    assert!(client.verify(&f.payload, &f.key_data, &f.sig_data));
}

#[test]
fn verifies_when_key_data_carries_a_credential_id_suffix() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    let mut key_data = f.key_data.clone();
    key_data.extend_from_array(&[0xab; 20]);

    assert!(client.verify(&f.payload, &key_data, &f.sig_data));
}

#[test]
#[should_panic(expected = "Error(Crypto, InvalidInput)")]
fn rejects_a_tampered_signature() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    let mut bytes = f.sig_data.signature.to_array();
    bytes[0] ^= 0xff;

    let sig_data = WebAuthnSigData {
        signature: BytesN::<64>::from_array(&f.env, &bytes),
        ..f.sig_data.clone()
    };

    client.verify(&f.payload, &f.key_data, &sig_data);
}

/// The challenge binds the assertion to one payload; reusing it must fail.
#[test]
#[should_panic(expected = "Error(Contract, #")]
fn rejects_an_assertion_replayed_against_another_payload() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    let other = Bytes::from_array(&f.env, &[3u8; 32]);

    client.verify(&other, &f.key_data, &f.sig_data);
}

/// A signing ceremony ("webauthn.create") is not an assertion ("webauthn.get").
#[test]
#[should_panic(expected = "Error(Contract, #")]
fn rejects_a_wrong_client_data_type() {
    let f = fixture_with(GOOD_FLAGS, "webauthn.create");
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    client.verify(&f.payload, &f.key_data, &f.sig_data);
}

/// User Verified unset means no biometric/PIN: the account must not accept it.
#[test]
#[should_panic(expected = "Error(Contract, #")]
fn rejects_an_assertion_without_user_verification() {
    let f = fixture_with(AUTH_DATA_FLAGS_UP, "webauthn.get");
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    client.verify(&f.payload, &f.key_data, &f.sig_data);
}

#[test]
fn canonicalizes_a_key_by_stripping_the_credential_id() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    let mut key_data = f.key_data.clone();
    key_data.extend_from_array(&[0xcd; 16]);

    let canonical = client.canonicalize_key(&key_data);

    assert_eq!(canonical, Bytes::from_array(&f.env, &f.public_key.to_array()));
    assert_eq!(canonical.len(), 65);
}

#[test]
fn batch_canonicalize_preserves_order() {
    let f = fixture();
    let client = WebAuthnVerifierClient::new(&f.env, &f.client_id);

    let mut suffixed = f.key_data.clone();
    suffixed.extend_from_array(&[1u8; 8]);
    let keys = Vec::from_array(&f.env, [suffixed, f.key_data.clone()]);

    let canonical = client.batch_canonicalize_key(&keys);

    assert_eq!(canonical.len(), 2);
    assert_eq!(canonical.get(0).unwrap(), canonical.get(1).unwrap());
}

#[test]
#[ignore]
fn print_fixture_hex() {
    fn hex(b: &[u8]) -> std::string::String {
        b.iter().map(|x| std::format!("{x:02x}")).collect()
    }
    fn bytes_hex(b: &Bytes) -> std::string::String {
        let mut out = std::vec::Vec::new();
        for i in 0..b.len() {
            out.push(b.get(i).unwrap());
        }
        hex(&out)
    }
    let f = fixture();
    std::println!("WA_PAYLOAD={}", bytes_hex(&f.payload));
    std::println!("WA_KEY={}", bytes_hex(&f.key_data));
    std::println!("WA_SIG={}", hex(&f.sig_data.signature.to_array()));
    std::println!("WA_AUTHDATA={}", bytes_hex(&f.sig_data.authenticator_data));
    std::println!("WA_CLIENTDATA={}", bytes_hex(&f.sig_data.client_data));
}
