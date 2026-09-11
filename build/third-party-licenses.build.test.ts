/*
 * Integration tests: run real Vite builds of tiny fixture projects through the
 * thirdPartyLicenses() plugins and check that the build fails closed on
 * AGPL, unlicensed and private copyleft packages, and emits the notices file
 * for a permissive one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

import { THIRD_PARTY_LICENSES_FILE, thirdPartyLicenses } from "./third-party-licenses.ts";

interface FixturePackage {
  json: Record<string, unknown>;
  files: Record<string, string>;
}

interface BuildOutputItem {
  fileName: string;
  type: string;
  source?: string | Uint8Array;
}

const created: string[] = [];

const mitText = (holder: string) =>
  `MIT License\n\nCopyright (c) 2024 ${holder}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n`;

/*
 * Fixture modules export real functions, not constants: the bundler inlines
 * constants into the caller and drops the module, which would hide it from
 * the license scan (correctly, since no code of it would ship).
 */
const functionModule = (exportName: string, tag: string) =>
  `export function ${exportName}(input) {\n  return [${JSON.stringify(tag)}, String(input)].join(":");\n}\n`;

const callEntry = (imports: Array<{ name: string; from: string }>) =>
  imports.map(({ name, from }) => `import { ${name} } from ${JSON.stringify(from)};`).join("\n") +
  `\nconsole.log(${imports.map(({ name }) => `${name}(Date.now())`).join(", ")});\n`;

function fixture(packages: Record<string, FixturePackage>, entry: string): string {
  const root = mkdtempSync(join(tmpdir(), "promptrail-license-fixture-"));
  created.push(root);

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "0.0.0", private: true, type: "module" })
  );

  for (const [name, pkg] of Object.entries(packages)) {
    const dir = join(root, "node_modules", name);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg.json));

    for (const [file, content] of Object.entries(pkg.files)) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
  }

  writeFileSync(join(root, "entry.js"), entry);
  return root;
}

const esmPackage = (json: Record<string, unknown>, files: Record<string, string> = {}): FixturePackage => ({
  json: { version: "1.0.0", type: "module", main: "index.js", ...json },
  files: { "index.js": functionModule("value", String(json.name)), ...files },
});

async function buildFixture(root: string): Promise<BuildOutputItem[]> {
  const result = await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: thirdPartyLicenses({ root }),
    build: { write: false, minify: false, rolldownOptions: { input: join(root, "entry.js") } },
  });

  const bundle = (Array.isArray(result) ? result[0] : result) as unknown as { output: BuildOutputItem[] };
  return bundle.output;
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("thirdPartyLicenses() in a real build", () => {
  it("emits the notices file for a permissive package", async () => {
    const root = fixture(
      { "mit-pkg": esmPackage({ name: "mit-pkg", license: "MIT" }, { LICENSE: mitText("Fixture Author") }) },
      callEntry([{ name: "value", from: "mit-pkg" }])
    );

    const output = await buildFixture(root);
    const asset = output.find((item) => item.fileName === THIRD_PARTY_LICENSES_FILE);

    expect(asset?.type).toBe("asset");

    const text = String(asset?.source);

    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.charCodeAt(1)).not.toBe(0xfeff);
    expect(text).toContain("Bundled packages: 1");
    expect(text).toContain("mit-pkg@1.0.0 (MIT)");
    expect(text).toContain("Copyright (c) 2024 Fixture Author");
    expect(text).toMatch(/^ {2}vite@\S+ \(MIT\)$/m);
    expect(text).toMatch(/^ {2}rolldown@\S+ \(MIT\)$/m);
  });

  it("fails on an AGPL package", async () => {
    const root = fixture(
      { "agpl-pkg": esmPackage({ name: "agpl-pkg", license: "AGPL-3.0-only" }, { LICENSE: "GNU AFFERO GENERAL PUBLIC LICENSE" }) },
      callEntry([{ name: "value", from: "agpl-pkg" }])
    );

    await expect(buildFixture(root)).rejects.toThrow(
      /Dependency "agpl-pkg" has a license \(AGPL-3\.0-only\) which is not compatible/
    );
  });

  it("fails on a package with no license field (the xBull connector case)", async () => {
    const root = fixture(
      { "nolicense-pkg": esmPackage({ name: "nolicense-pkg" }) },
      callEntry([{ name: "value", from: "nolicense-pkg" }])
    );

    await expect(buildFixture(root)).rejects.toThrow(/nolicense-pkg" does not specify any license/);
  });

  it("fails on a private sub-package manifest with a copyleft license", async () => {
    const root = fixture(
      {
        "parent-pkg": esmPackage(
          { name: "parent-pkg", license: "MIT" },
          {
            LICENSE: mitText("Parent Author"),
            "sub/package.json": JSON.stringify({
              name: "parent-pkg-sub",
              version: "1.0.0",
              private: true,
              type: "module",
              main: "index.js",
              license: "GPL-3.0",
            }),
            "sub/index.js": functionModule("sub", "gpl"),
          }
        ),
      },
      callEntry([
        { name: "value", from: "parent-pkg" },
        { name: "sub", from: "parent-pkg/sub" },
      ])
    );

    await expect(buildFixture(root)).rejects.toThrow(
      /Dependency "parent-pkg-sub" has a license \(GPL-3\.0\) which is not compatible/
    );
  });

  it("fails on a bundled package that ships no license text", async () => {
    const root = fixture(
      { "textless-pkg": esmPackage({ name: "textless-pkg", license: "MIT" }) },
      callEntry([{ name: "value", from: "textless-pkg" }])
    );

    await expect(buildFixture(root)).rejects.toThrow(/textless-pkg@1\.0\.0 is bundled but ships no license text/);
  });
});
