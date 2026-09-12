/*
 * Render smoke test for the ramp panel: the initial (pre-discovery) state
 * must render without a wallet or network. Effects do not run under
 * renderToString, so no anchor call is made.
 */

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ANCHOR_HOME_DOMAIN } from "../config/stellar";

/*
 * The wallet kit pulls browser-extension shims (Freighter) that do not load
 * under Node; the panel only needs a signer function from it.
 */
vi.mock("../services/wallet", () => ({
  signWithWallet: vi.fn(),
}));

import TryRamp from "./TryRamp";

describe("TryRamp", () => {
  it("renders the discovery state for a connected wallet", () => {
    const html = renderToString(
      <TryRamp walletAddress="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />
    );

    expect(html).toContain("TRY ON/OFF-RAMP");
    expect(html).toContain(ANCHOR_HOME_DOMAIN);
    expect(html).toContain("stellar.toml");
    expect(html).toContain("discovering");
    expect(html).not.toContain("Get quote");
  });
});
