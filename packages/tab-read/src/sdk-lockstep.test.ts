import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * The one rule this package lives by (see index.ts): it and every consumer
 * must resolve the SAME @stellar/stellar-sdk. Two checks, because the failure
 * can arrive either way: a consumer declares a different range, or npm
 * installs two copies of the same range (which it did the first time this
 * package was added -- the root held web's 17, so mcp and tab-read each got
 * their own nested 16.3.0). The root package.json now lists ^16.3.0 as a
 * devDependency purely so that the shared copy is the hoisted one.
 */
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const manifest = (path: string) =>
  JSON.parse(readFileSync(here(path), "utf8")) as { name: string; dependencies?: Record<string, string> };

const sdkPathFrom = (dir: string) => realpathSync(createRequire(here(dir)).resolve("@stellar/stellar-sdk"));

describe("@stellar/stellar-sdk", () => {
  it("is declared with the same range by this package and every consumer", () => {
    const own = manifest("../package.json");
    const range = own.dependencies?.["@stellar/stellar-sdk"];
    expect(range).toBe("^16.3.0");

    const consumers = ["../../mcp-server/package.json", "../../web/package.json"]
      .map(manifest)
      .filter((m) => m.dependencies?.[own.name] !== undefined);

    expect(consumers.map((m) => m.name)).toContain("@barkeep/mcp");
    for (const consumer of consumers) {
      expect(consumer.dependencies?.["@stellar/stellar-sdk"], `${consumer.name} must match ${own.name}`).toBe(range);
    }
  });

  it("resolves to one installed copy from this package and from the MCP server", () => {
    const own = sdkPathFrom("../src/reader.ts");
    const mcp = sdkPathFrom("../../mcp-server/src/chain.ts");

    expect(mcp).toBe(own);
  });
});
