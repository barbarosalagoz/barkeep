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

  it("defaults an unset, empty or whitespace-only value to testnet", () => {
    expect(parseNetwork(undefined)).toBe("testnet");
    expect(parseNetwork("")).toBe("testnet");
    expect(parseNetwork("  ")).toBe("testnet");
    expect(parseNetwork("\t\n")).toBe("testnet");
  });

  it("still trims a value that names a real network", () => {
    expect(parseNetwork("  public  ")).toBe("public");
    expect(parseNetwork("\ttestnet\n")).toBe("testnet");
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
