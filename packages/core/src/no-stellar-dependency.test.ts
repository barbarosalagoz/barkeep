/*
 * Mechanical enforcement of the hard constraint documented in index.ts and
 * README.md: @barkeep/core must never depend on @stellar/*.
 *
 * The rule is not style. @barkeep/web runs @stellar/stellar-sdk 17 and
 * @barkeep/mcp runs ^16.3.0; npm installs both. A type from one copy is not
 * assignable to the same-named type from the other, so an SDK type re-exported
 * through this shared package would break type identity for every value that
 * crosses the web/mcp boundary.
 *
 * Two checks, because a violation can arrive either way: someone adds the
 * dependency to the manifest, or someone writes the import against a copy that
 * npm hoisted to the workspace root and happens to resolve without it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..");
const SELF = fileURLToPath(import.meta.url);

const FORBIDDEN_SCOPE = "@stellar/";

/** Every module specifier in `source`, from static, dynamic and CJS forms. */
function moduleSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
  const found: string[] = [];

  for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

/** Every .ts file in the package, excluding node_modules and this test. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sourceFiles(path, acc);
    } else if (entry.name.endsWith(".ts") && path !== SELF) {
      acc.push(path);
    }
  }

  return acc;
}

describe("@barkeep/core takes no Stellar SDK dependency", () => {
  it("declares no @stellar/* package in its manifest", () => {
    const manifest = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")
    ) as Record<string, Record<string, string> | undefined>;

    const declared = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ].flatMap((field) => Object.keys(manifest[field] ?? {}));

    expect(declared.filter((name) => name.startsWith(FORBIDDEN_SCOPE))).toEqual([]);
  });

  it("imports no @stellar/* module in any source file", () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(PACKAGE_ROOT)) {
      for (const specifier of moduleSpecifiers(readFileSync(file, "utf8"))) {
        if (specifier.startsWith(FORBIDDEN_SCOPE)) {
          offenders.push(`${relative(PACKAGE_ROOT, file)} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /*
   * Guards the guard: if the scanner silently stopped finding files, or the
   * specifier regex stopped matching, both checks above would pass vacuously.
   */
  it("actually scans this package and parses imports", () => {
    const files = sourceFiles(PACKAGE_ROOT);

    expect(files.length).toBeGreaterThan(0);
    expect(files.some((file) => file.endsWith("index.ts"))).toBe(true);
    expect(moduleSpecifiers(`import { x } from "@stellar/stellar-sdk";`)).toEqual([
      "@stellar/stellar-sdk",
    ]);
  });
});
