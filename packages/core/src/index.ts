/*
 * @barkeep/core — primitives shared by @barkeep/web and @barkeep/mcp.
 *
 * HARD CONSTRAINT: this package must never depend on @stellar/* — not in its
 * manifest, not in an import, not even as a type-only import.
 *
 * Why: the two consumers deliberately run different Stellar SDK majors.
 * @barkeep/web is on @stellar/stellar-sdk 17; @barkeep/mcp is pinned to ^16.3.0
 * because @x402/stellar 2.25.0 declares that floor to avoid v17's XDR API
 * rewrite. npm resolves both, so they coexist as two distinct copies on disk.
 * A type that originates in one copy is NOT assignable to the same-named type
 * from the other: structurally similar, nominally different. If @barkeep/core
 * exposed an SDK type it would have to pick one copy, and every value crossing
 * the web/mcp boundary through this package would carry the wrong identity.
 *
 * So core holds only SDK-free primitives: plain constants, the error taxonomy,
 * receipt types and decimal-string helpers. Anything that needs an SDK type
 * belongs in the consumer that owns that SDK version.
 *
 * Enforced by no-stellar-dependency.test.ts, which fails the build on any
 * @stellar/* import or dependency. See README.md.
 */

/** Stellar networks Barkeep runs against. */
export type StellarNetwork = "testnet" | "public";

/*
 * Network passphrases, as plain strings.
 *
 * These are the values of Networks.PUBLIC and Networks.TESTNET in
 * @stellar/stellar-sdk. They are protocol constants, fixed since 2015, and
 * inlining them is what lets the network configuration live here instead of
 * pulling the SDK across the boundary described above.
 */
export const NETWORK_PASSPHRASES: Readonly<Record<StellarNetwork, string>> = {
  public: "Public Global Stellar Network ; September 2015",
  testnet: "Test SDF Network ; September 2015",
};

/** The passphrase for a network, by name. */
export const networkPassphrase = (network: StellarNetwork): string =>
  NETWORK_PASSPHRASES[network];
