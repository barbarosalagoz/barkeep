import { describe, expect, it } from "vitest";

import { NETWORK_PASSPHRASES, networkPassphrase, parseNetwork } from "./network.ts";

describe("parseNetwork", () => {
  it("parses network names", () => {
    expect(parseNetwork(undefined)).toBe("testnet");
    expect(parseNetwork("testnet")).toBe("testnet");
    expect(parseNetwork("public")).toBe("public");
    expect(parseNetwork("MAINNET")).toBe("public");
    expect(() => parseNetwork("futurenet")).toThrow(/Unsupported/);
  });

  /*
   * Behaviour preserved from the web app verbatim: the empty check runs before
   * trim(), so "" defaults but a whitespace-only value is a misconfiguration
   * and throws. Asserted so the asymmetry is deliberate rather than discovered.
   */
  it("defaults an unset or empty value to testnet, but rejects whitespace", () => {
    expect(parseNetwork(undefined)).toBe("testnet");
    expect(parseNetwork("")).toBe("testnet");
    expect(() => parseNetwork("  ")).toThrow(/Unsupported/);
  });

  it("names the source in the message so callers keep their diagnostic", () => {
    expect(() => parseNetwork("futurenet", "VITE_STELLAR_NETWORK")).toThrow(
      /Unsupported VITE_STELLAR_NETWORK "futurenet"/
    );
    expect(() => parseNetwork("futurenet")).toThrow(/Unsupported network/);
  });
});

describe("network passphrases", () => {
  /*
   * These are protocol constants: @stellar/stellar-sdk's Networks.PUBLIC and
   * Networks.TESTNET. Core cannot import the SDK to compare against, which is
   * the whole point, so the literals are asserted here instead.
   */
  it("matches the Stellar protocol passphrases exactly", () => {
    expect(NETWORK_PASSPHRASES.public).toBe("Public Global Stellar Network ; September 2015");
    expect(NETWORK_PASSPHRASES.testnet).toBe("Test SDF Network ; September 2015");
  });

  it("resolves a passphrase by network", () => {
    expect(networkPassphrase("testnet")).toBe(NETWORK_PASSPHRASES.testnet);
    expect(networkPassphrase("public")).toBe(NETWORK_PASSPHRASES.public);
  });
});
