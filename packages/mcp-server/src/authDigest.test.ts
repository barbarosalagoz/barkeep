import { describe, expect, it } from "vitest";

import { authDigest, buildAuthPayload, contextRuleIdsToXdr, signerToScVal } from "./authDigest.ts";

/*
 * Every hex string below was emitted by the contract, not by this module:
 *
 *   cargo test -p barkeep-smart-account print_auth_digest_vectors -- --ignored --nocapture
 *
 * which runs Soroban's own Vec<u32>::to_xdr and env.crypto().sha256 inside a
 * real Env. That is what makes these cross-implementation checks rather than
 * this module agreeing with itself.
 */
const SEQ_PAYLOAD = Uint8Array.from({ length: 32 }, (_, i) => i);
const ZERO_PAYLOAD = new Uint8Array(32);

describe("contextRuleIdsToXdr", () => {
  it("matches Soroban's Vec<u32> encoding", () => {
    expect(contextRuleIdsToXdr([]).toString("hex")).toBe("000000100000000100000000");
    expect(contextRuleIdsToXdr([1, 2]).toString("hex")).toBe(
      "00000010000000010000000200000003000000010000000300000002"
    );
  });

  it("rejects anything that is not a u32", () => {
    expect(() => contextRuleIdsToXdr([-1])).toThrow(RangeError);
    expect(() => contextRuleIdsToXdr([1.5])).toThrow(RangeError);
    expect(() => contextRuleIdsToXdr([0x1_0000_0000])).toThrow(RangeError);
  });
});

describe("authDigest", () => {
  it("reproduces the digest the contract computes", () => {
    expect(authDigest(ZERO_PAYLOAD, [0]).toString("hex")).toBe(
      "cd8f38f416e883abd1c3fa555bfbe29f70a28c1ec9c1ebab27e0b055829a33ac"
    );
    expect(authDigest(SEQ_PAYLOAD, [1]).toString("hex")).toBe(
      "93d0d91205b61ce9d2d7e8d03b7f03d85a9420a09a087390367ca07baabf42a0"
    );
    expect(authDigest(SEQ_PAYLOAD, [1, 2]).toString("hex")).toBe(
      "38adbae1abad527443bb95a44f1dc45f4d7da7d235f40f00a010891a1c5589e2"
    );
    expect(authDigest(SEQ_PAYLOAD, []).toString("hex")).toBe(
      "28e8deb1fe446e87d7169b4ffe821d196a40486aa5a8b8e95798c6d76c82fdaf"
    );
  });

  /*
   * The property the digest exists for: changing which rules are selected must
   * change what was signed, so a signature cannot be moved between rules.
   */
  it("differs when only the rule selection differs", () => {
    const one = authDigest(SEQ_PAYLOAD, [1]).toString("hex");
    const two = authDigest(SEQ_PAYLOAD, [2]).toString("hex");
    const both = authDigest(SEQ_PAYLOAD, [1, 2]).toString("hex");

    expect(new Set([one, two, both]).size).toBe(3);
  });

  it("is order sensitive across contexts", () => {
    expect(authDigest(SEQ_PAYLOAD, [1, 2]).toString("hex")).not.toBe(
      authDigest(SEQ_PAYLOAD, [2, 1]).toString("hex")
    );
  });

  it("rejects a payload that is not 32 bytes", () => {
    expect(() => authDigest(new Uint8Array(31), [0])).toThrow(RangeError);
    expect(() => authDigest(new Uint8Array(33), [0])).toThrow(RangeError);
  });
});

const VERIFIER = "CCVOYY3CQGSJV42INAUOQMBSX2OIEOX355MUWRSHAW4LEHQNF3RQR5NJ";
const OTHER = "CBZ5BMHGTQAWIGF4ACZCOHLLYSQFKCYXRV5TFWCQ5T3JYFRHEEJHF3KL";

describe("buildAuthPayload", () => {
  it("encodes an external signer as [tag, verifier, key_data]", () => {
    const scv = signerToScVal({
      kind: "external",
      verifier: VERIFIER,
      keyData: new Uint8Array([1, 2, 3]),
    });

    const parts = scv.vec()!;

    expect(parts).toHaveLength(3);
    expect(parts[0].sym().toString()).toBe("External");
    expect(parts[2].bytes()).toEqual(Buffer.from([1, 2, 3]));
  });

  it("puts struct keys in sorted order", () => {
    const payload = buildAuthPayload(
      [
        {
          signer: { kind: "external", verifier: VERIFIER, keyData: new Uint8Array([9]) },
          signature: new Uint8Array(64),
        },
      ],
      [1]
    );

    const keys = payload.map()!.map((entry) => entry.key().sym().toString());

    expect(keys).toEqual(["context_rule_ids", "signers"]);
  });

  it("sorts the signers map by encoded key, as the host requires", () => {
    const a = { kind: "external", verifier: VERIFIER, keyData: new Uint8Array([1]) } as const;
    const b = { kind: "external", verifier: OTHER, keyData: new Uint8Array([2]) } as const;

    const forward = buildAuthPayload(
      [
        { signer: a, signature: new Uint8Array(64) },
        { signer: b, signature: new Uint8Array(64) },
      ],
      [1]
    );
    const reversed = buildAuthPayload(
      [
        { signer: b, signature: new Uint8Array(64) },
        { signer: a, signature: new Uint8Array(64) },
      ],
      [1]
    );

    // Same set of signers must encode identically regardless of input order.
    expect(forward.toXDR("hex")).toBe(reversed.toXDR("hex"));
  });

  it("round-trips through XDR", () => {
    const payload = buildAuthPayload(
      [
        {
          signer: { kind: "delegated", address: VERIFIER },
          signature: new Uint8Array([7, 7]),
        },
      ],
      [0, 3]
    );

    expect(payload.toXDR("hex").length).toBeGreaterThan(0);
    expect(
      payload
        .map()!
        .find((e) => e.key().sym().toString() === "context_rule_ids")!
        .val()
        .vec()!
        .map((v) => v.u32())
    ).toEqual([0, 3]);
  });
});
