import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { authDigest } from "./authDigest.ts";
import {
  authDigestPreimageScVal,
  authDigestV09,
  delegateAuthInvocation,
} from "./authDigestPreimage.ts";

/*
 * Every hex string below was emitted by the contract, not by this module:
 *
 *   cargo test -p barkeep-v09-smart-account print_auth_digest_preimage_vectors \
 *     -- --ignored --nocapture
 *
 * which encodes a real AuthDigestPreimage with Soroban's own to_xdr and hashes
 * it with env.crypto().sha256, at stellar-accounts 4529d70.
 */
const ACCOUNT_A = "CCAO6UVMZ2JGUAGIQKMVHXKWKD7TZKW2YP77M2NK56MWL6LC66ZZ3FLH";
const ACCOUNT_B = "CBEILTNYZEE5KX6WTSRON3FCXE7KBYAAUVUWY7TWEUBIEHIY47NVPWBZ";
const SEQ = Uint8Array.from({ length: 32 }, (_, i) => i);
const ZERO = new Uint8Array(32);

const A_SEQ_RULE1_XDR =
  "0000001100000001000000030000000f000000076163636f756e7400000000120000000180ef52acce926a00c8829953dd5650ff3caadac3fff669aaef9965f962f7b39d0000000f00000010636f6e746578745f72756c655f69647300000010000000010000000100000003000000010000000f000000117369676e61747572655f7061796c6f61640000000000000d00000020000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

describe("authDigestPreimageScVal", () => {
  it("encodes byte-for-byte as the contract does", () => {
    expect(authDigestPreimageScVal(ACCOUNT_A, SEQ, [1]).toXDR("hex")).toBe(A_SEQ_RULE1_XDR);
  });

  it("orders keys account, context_rule_ids, signature_payload", () => {
    const keys = authDigestPreimageScVal(ACCOUNT_A, SEQ, [1])
      .map()!
      .map((entry) => entry.key().sym().toString());

    expect(keys).toEqual(["account", "context_rule_ids", "signature_payload"]);
  });

  it("rejects a payload that is not 32 bytes and a rule id that is not a u32", () => {
    expect(() => authDigestPreimageScVal(ACCOUNT_A, new Uint8Array(31), [0])).toThrow(RangeError);
    expect(() => authDigestPreimageScVal(ACCOUNT_A, SEQ, [-1])).toThrow(RangeError);
  });
});

describe("authDigestV09", () => {
  it("reproduces the digest the contract computes", () => {
    expect(authDigestV09(ACCOUNT_A, ZERO, [0]).toString("hex")).toBe(
      "28c8a559f64480741343612516df25cc4eaab37894bad15da1d75270076e5086"
    );
    expect(authDigestV09(ACCOUNT_A, SEQ, [1]).toString("hex")).toBe(
      "6efaf6588c5ad48d55ca39ec2cf6c933b65981d894df28964d9ed526268aaf23"
    );
    expect(authDigestV09(ACCOUNT_A, SEQ, [1, 2]).toString("hex")).toBe(
      "e6cd93f11bb90a13ad83a72c5e20da977e1df1c8aed1e3391e6c07cd20c66771"
    );
    expect(authDigestV09(ACCOUNT_B, SEQ, [1]).toString("hex")).toBe(
      "1b8c56e39ec0211d1268dc4be629fa9fbf2568435f88b0b70069b0f4ea7e9acd"
    );
  });

  it("binds the account, which the 0.7.2 digest does not", () => {
    expect(authDigestV09(ACCOUNT_A, SEQ, [1])).not.toEqual(authDigestV09(ACCOUNT_B, SEQ, [1]));
    // The 0.7.2 scheme has no account input at all.
    expect(authDigest(SEQ, [1])).not.toEqual(authDigestV09(ACCOUNT_A, SEQ, [1]));
  });
});

describe("delegateAuthInvocation", () => {
  it("is __check_auth on the account with the preimage map as the only argument", () => {
    const fn = delegateAuthInvocation(ACCOUNT_A, SEQ, [1]).function().contractFn();

    expect(fn.functionName().toString()).toBe("__check_auth");
    expect(fn.args()).toHaveLength(1);
    expect(fn.args()[0].switch()).toBe(xdr.ScValType.scvMap());
    expect(fn.args()[0].toXDR("hex")).toBe(A_SEQ_RULE1_XDR);
  });
});
