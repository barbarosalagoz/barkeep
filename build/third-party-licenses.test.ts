/*
 * Unit tests for the third-party notices build step: the license allow-list,
 * copyright-line extraction, and the fail-closed rendering rules.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Dependency } from "rollup-plugin-license";
import { describe, expect, it } from "vitest";

import {
  buildToolEntries,
  copyrightLines,
  isAllowedLicense,
  owningPackage,
  renderNotices,
  sourceNoticesByPackage,
} from "./third-party-licenses.ts";

/** Repo root, independent of the directory vitest was started from. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function dependency(overrides: Partial<Record<keyof Dependency, unknown>>): Dependency {
  return {
    name: "example",
    version: "1.0.0",
    description: null,
    repository: null,
    homepage: null,
    private: false,
    license: "MIT",
    licenseText: "MIT License\n\nCopyright (c) 2024 Example Author\n\nPermission is hereby granted...",
    noticeText: null,
    author: null,
    contributors: [],
    maintainers: [],
    text: () => "",
    ...overrides,
  } as Dependency;
}

describe("isAllowedLicense", () => {
  it("accepts permissive licenses and permissive expressions", () => {
    for (const expression of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "0BSD", "(MIT OR Apache-2.0)", "(MIT AND Apache-2.0)", "MIT OR GPL-3.0"]) {
      expect(isAllowedLicense(expression), expression).toBe(true);
    }
  });

  it("rejects copyleft, source-available, missing and malformed licenses", () => {
    for (const expression of [null, undefined, "", "GPL-3.0", "AGPL-3.0", "AGPL-3.0-or-later", "LGPL-3.0-only", "SSPL-1.0", "BUSL-1.1", "SEE LICENSE IN LICENSE.md", "UNLICENSED", "(GPL-3.0 AND MIT)", { type: "MIT" }]) {
      expect(isAllowedLicense(expression), JSON.stringify(expression)).toBe(false);
    }
  });

  it("sends mixed AND/OR expressions with parentheses to manual review", () => {
    expect(isAllowedLicense("(MIT OR Apache-2.0) AND BSD-3-Clause")).toBe(false);
  });
});

describe("copyrightLines", () => {
  it("extracts notice lines and ignores license prose", () => {
    const apache = [
      "Apache License",
      "(c) You must retain, in the Source form of any Derivative Works",
      "      copyright notice that is included in or attached to the work",
      "Copyright [yyyy] [name of copyright owner]",
      "Copyright 2015 Stellar Development Foundation",
    ].join("\n");
    const mit =
      "MIT License\n\nCopyright (c) Meta Platforms, Inc. and affiliates.\n\n" +
      "The above copyright notice and this permission notice shall be included\n" +
      "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE";

    expect(copyrightLines(apache)).toEqual(["Copyright 2015 Stellar Development Foundation"]);
    expect(copyrightLines(mit)).toEqual(["Copyright (c) Meta Platforms, Inc. and affiliates."]);
  });

  it("recognises notice formats without a year or at a comment prefix", () => {
    expect(
      copyrightLines(
        [
          "(c) 2019 Someone",
          "© Bar Inc.",
          "Copyright Joyent, Inc. and other Node contributors.",
          " * Copyright (c) 2015 Foo",
          "The MIT License (MIT) Copyright (c) 2016 Baz",
          "Copyright (c) <year> <copyright holders>",
        ].join("\n")
      )
    ).toEqual([
      "(c) 2019 Someone",
      "© Bar Inc.",
      "Copyright Joyent, Inc. and other Node contributors.",
      "Copyright (c) 2015 Foo",
      "The MIT License (MIT) Copyright (c) 2016 Baz",
    ]);
  });
});

describe("renderNotices", () => {
  it("lists every package, sorted, with license text and copyright lines", () => {
    const text = renderNotices([dependency({ name: "b-pkg" }), dependency({ name: "a-pkg" })], ROOT, []);

    expect(text).toContain("Bundled packages: 2");
    expect(text.indexOf("a-pkg@1.0.0")).toBeLessThan(text.indexOf("b-pkg@1.0.0"));
    expect(text).toContain("Copyright (c) 2024 Example Author");
    expect(text).toContain("License text source: LICENSE file in the npm package");
  });

  it("leaves the project itself out of the list", () => {
    const text = renderNotices([dependency({ name: "promptrail", version: "0.0.0", private: true })], ROOT, []);

    expect(text).toContain("Bundled packages: 0");
  });

  it("normalises CRLF license texts", () => {
    const text = renderNotices(
      [dependency({ licenseText: "MIT License\r\n\r\nCopyright (c) 2024 CRLF Author\r\n" })],
      ROOT,
      []
    );

    expect(text).not.toContain("\r");
    expect(text).toContain("Copyright (c) 2024 CRLF Author");
  });

  it("uses the vendored upstream text when the package ships none", () => {
    const text = renderNotices(
      [dependency({ name: "@creit.tech/stellar-wallets-kit", version: "2.6.0", licenseText: null })],
      ROOT,
      []
    );

    expect(text).toContain("Copyright (c) 2023 Creit Technologies LLP.");
    expect(text).toContain("https://github.com/Creit-Tech/Stellar-Wallets-Kit/blob/v2.6.0/LICENSE");
  });

  it("covers a private sub-package with its parent's license text", () => {
    const text = renderNotices(
      [
        dependency({ name: "preact", version: "10.29.8", licenseText: "MIT License\n\nCopyright (c) 2015-present Jason Miller" }),
        dependency({ name: "preact-hooks", version: "0.1.0", private: true, licenseText: null }),
      ],
      ROOT,
      []
    );

    expect(text).toContain("license of preact@10.29.8");
  });

  it("names the author instead of inventing a notice when the text has none", () => {
    const text = renderNotices(
      [
        dependency({
          name: "@stellar/freighter-api",
          version: "6.0.0",
          license: "Apache-2.0",
          licenseText: null,
          author: { name: "Stellar Development Foundation", email: "hello@stellar.org", url: null, text: () => "" },
        }),
      ],
      ROOT,
      []
    );

    expect(text).toContain(
      "(no copyright line detected in the license text; package author: Stellar Development Foundation <hello@stellar.org>; see the full text below)"
    );
  });

  it("fails the build for a bundled package without license text or override", () => {
    expect(() => renderNotices([dependency({ name: "no-license-pkg", licenseText: null })], ROOT, [])).toThrow(
      /no-license-pkg@1\.0\.0 is bundled but ships no license text/
    );
  });

  it("renders no BOM: only the emitted asset carries one", () => {
    expect(renderNotices([dependency({})], ROOT, []).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("fails when a coveredBy parent is not bundled", () => {
    expect(() =>
      renderNotices([dependency({ name: "preact-hooks", version: "0.1.0", licenseText: null })], ROOT, [])
    ).toThrow(/mapped to preact, which is not bundled with a license text/);
  });

  it("lists copyright headers found in a package's bundled source files", () => {
    const text = renderNotices([dependency({ name: "a-pkg" })], ROOT, [], new Map([["a-pkg@1.0.0", ["Copyright 2009 The Go Authors. All rights reserved."]]]));

    expect(text).toContain("Copyright notices in this package's bundled source files:");
    expect(text).toContain("Copyright 2009 The Go Authors. All rights reserved.");
  });

  it("credits the build tools' runtime helpers", () => {
    const tools = buildToolEntries();

    expect(tools.map((tool) => tool.id.split("@")[0])).toEqual(["vite", "rolldown"]);
    expect(tools.every((tool) => tool.license === "MIT")).toBe(true);
    expect(tools[0].licenseText).toContain("VoidZero Inc. and Vite contributors");
    expect(tools[0].licenseText).not.toContain("Licenses of bundled dependencies");
    // Rolldown's interop runtime derives from rollup/esbuild; keep their notices.
    expect(tools[1].licenseText).toContain("THIRD-PARTY-LICENSE:");
  });
});

describe("module attribution", () => {
  const kitFile = join(
    ROOT,
    "node_modules/@creit.tech/stellar-wallets-kit/esm/deps/jsr.io/@std/encoding/1.0.11/hex.js"
  );

  it("attributes a bundled file to the package that owns it", () => {
    expect(owningPackage(kitFile)?.id).toBe("@creit.tech/stellar-wallets-kit@2.6.0");
    expect(owningPackage("\0vite/modulepreload-polyfill.js")).toBeNull();
    expect(owningPackage(join(ROOT, "src/App.tsx"))).toBeNull();
  });

  it("finds vendored third-party notices inside a package's bundled files", () => {
    const notices = sourceNoticesByPackage([kitFile]).get("@creit.tech/stellar-wallets-kit@2.6.0") ?? [];

    expect(notices).toContain("Copyright 2009 The Go Authors. All rights reserved.");
    expect(notices).toContain("Copyright 2018-2026 the Deno authors. MIT license.");
  });
});
