/*
 * Third-party license notices for the shipped web bundle.
 *
 * rollup-plugin-license (MIT) collects every npm package whose code ends up
 * in the rendered chunks, with its license field, LICENSE text and NOTICE
 * text. This module turns that into a plain-text notices file, emits it as a
 * build asset (served at <base>third-party-licenses.txt), and FAILS THE BUILD
 * when:
 *
 *   - a bundled package declares no license, or a license outside the
 *     permissive allow-list below (this is what keeps AGPL/GPL/unlicensed
 *     code such as @creit.tech/xbull-wallet-connect out of the bundle);
 *   - a bundled package ships no license text and has no vendored override
 *     or "coveredBy" mapping in build/license-overrides/overrides.json;
 *   - a bundled module belongs to a package that is missing from the report.
 *
 * Private sub-package manifests (e.g. preact/hooks/package.json) are checked
 * as well, so they cannot slip past the allow-list. Copyright headers inside
 * the bundled source files are listed too, because packages vendor
 * third-party code whose notices are not in their LICENSE file (the wallet
 * kit vendors JSR @std/encoding, which carries Deno, Go and other notices).
 * The runtime helpers the build tools inject are credited at the end.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import licenseImport from "rollup-plugin-license";
import type { Dependency, Options, Person } from "rollup-plugin-license";
import type { Plugin } from "vite";

type LicensePluginFactory = (options: Options) => Plugin;

/*
 * rollup-plugin-license is CommonJS (module.exports = fn) but its typings say
 * `export default`, which TypeScript's nodenext mode reads as a `.default`
 * property. At runtime the default import is the function itself; accept
 * either shape.
 */
const license: LicensePluginFactory =
  (licenseImport as unknown as { default?: LicensePluginFactory }).default ??
  (licenseImport as unknown as LicensePluginFactory);

export const THIRD_PARTY_LICENSES_FILE = "third-party-licenses.txt";

/** Repository root: this file lives in <root>/build/. No trailing separator. */
export const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const OVERRIDES_DIR = "build/license-overrides";

/** SPDX ids a bundled package may use, alone or combined with AND / OR. */
const ALLOWED_LICENSES = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "Zlib",
]);

const RULE = "-".repeat(80);

/** How much of each bundled source file to scan for copyright headers. */
const HEADER_BYTES = 4096;

interface VendoredText {
  /** License text file, relative to build/license-overrides/. */
  file: string;
  source: string;
  gitBlob: string;
  reason: string;
}

interface LicenseOverride {
  /** Vendored upstream license text, relative to build/license-overrides/. */
  file?: string;
  /** A bundled package whose license text covers this sub-package manifest. */
  coveredBy?: string;
  /** Licenses of third-party code vendored inside this package. */
  extraTexts?: VendoredText[];
  source?: string;
  gitBlob?: string;
  reason: string;
}

export interface NoticeEntry {
  id: string;
  license: string;
  repository: string;
  licenseText: string;
  noticeText: string | null;
  textSource: string;
  author: string | null;
  role?: string;
  /** Copyright headers found in this package's bundled source files. */
  sourceNotices?: string[];
  /** Licenses of third-party code vendored inside this package. */
  vendoredTexts?: Array<{ text: string; source: string; reason: string }>;
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Normalize line endings so Windows and Linux builds emit identical files. */
function normalizeText(text: string | null | undefined): string | null {
  const normalized = text?.replace(/\r\n?/g, "\n").trim();
  return normalized ? normalized : null;
}

/**
 * True when the SPDX expression can be satisfied using only allow-listed
 * licenses. Non-string values and expressions that mix parentheses with both
 * AND and OR are rejected so a human reviews them instead of a naive parse.
 */
export function isAllowedLicense(expression: unknown): boolean {
  if (typeof expression !== "string" || !expression.trim()) {
    return false;
  }

  const hasParens = /[()]/.test(expression);
  const hasAnd = /\bAND\b/.test(expression);
  const hasOr = /\bOR\b/.test(expression);

  if (hasParens && hasAnd && hasOr) {
    return false;
  }

  return expression
    .replace(/[()]/g, " ")
    .trim()
    .split(/\s+OR\s+/)
    .some((option) =>
      option
        .split(/\s+AND\s+/)
        .every((term) => ALLOWED_LICENSES.has(term.trim()))
    );
}

/**
 * Copyright notice lines from license/notice texts or source headers,
 * excluding the license's own prose ("the above copyright notice",
 * Apache-2.0 section 4's "(c) You must retain", unfilled templates).
 */
export function copyrightLines(...texts: Array<string | null>): string[] {
  const found = new Set<string>();

  for (const text of texts) {
    if (!text) continue;

    for (const raw of text.split(/\r?\n/)) {
      // Allow notices inside comment blocks: " * Copyright ...", "// ...", "# ...".
      const line = raw.replace(/^\s*(?:\*|\/\/|#|;|--)?\s*/, "").trim();

      if (!line) continue;
      if (/\[yyyy\]|\[name of copyright owner\]|<year>|<copyright holders?>/i.test(line)) continue;

      const leadingWord =
        /^Copyright\b/.test(line) &&
        !/^Copyright\s+(?:notice|notices|owner|owners|holder|holders|law|laws|statement|and)\b/i.test(line);
      const shouting = /^COPYRIGHT\b/.test(line) && /\b(?:19|20)\d{2}\b/.test(line);
      /*
       * A bare "(c)" or "©" only counts with a year or an organisation word.
       * Source files are scanned too, where "(c) => c.type === ..." is an
       * arrow function and Apache-2.0 section 4's "(c) You must retain" is
       * list prose, not a notice.
       */
      const mark =
        /^(?:\(c\)|©)\s*\S/i.test(line) &&
        !/^\(c\)\s*(?:=>|[=,;:)\]}])/.test(line) &&
        (/\b(?:19|20)\d{2}\b/.test(line) ||
          /\b(?:Inc|LLC|Ltd|GmbH|Foundation|Team|Authors|Contributors|Corporation|Company|Project|University)\b/i.test(line));
      const inline = /\bCopyright\s*(?:\(c\)|©)\s*\S/.test(line);

      if (leadingWord || shouting || mark || inline) {
        found.add(line);
      }
    }
  }

  return [...found];
}

function personText(person: Person | null): string | null {
  if (!person) return null;
  return person.email ? `${person.name} <${person.email}>` : person.name;
}

function repositoryText(repository: unknown, homepage?: string | null): string {
  if (typeof repository === "string" && repository) return repository;
  if (repository && typeof repository === "object" && "url" in repository) {
    const url = (repository as { url?: unknown }).url;
    if (typeof url === "string" && url) return url;
  }
  return homepage ?? "not stated";
}

function loadOverrides(root: string): Record<string, LicenseOverride> {
  const path = join(root, OVERRIDES_DIR, "overrides.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, LicenseOverride>)
    : {};
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readProjectName(root: string): string | null {
  const json = readJson(join(root, "package.json"));
  return typeof json?.name === "string" ? json.name : null;
}

/** How far up from `root` to look for the workspace root's package.json. */
const WORKSPACE_SEARCH_DEPTH = 6;

/**
 * Directories matched by one npm `workspaces` entry, resolved against `base`.
 *
 * Only the trailing single-segment wildcard npm workspaces actually use in
 * practice ("packages/*") and literal paths are supported; anything else is
 * ignored rather than half-matched.
 */
function expandWorkspaceGlob(base: string, glob: string): string[] {
  const star = glob.indexOf("*");

  if (star === -1) return [join(base, glob)];
  if (glob.slice(star) !== "*") return [];

  const parent = join(base, glob.slice(0, star));

  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

/**
 * The project's own package names: `root`'s, plus every sibling of the npm
 * workspace that contains it.
 *
 * First-party code is bundled like any dependency, but it is not a third party:
 * it is covered by the repository's own LICENSE and belongs in neither the
 * notices file nor its completeness check. Before the workspace split this was
 * a single name, which was enough when the repository was one package.
 * @barkeep/web now bundles @barkeep/core, a sibling that ships no LICENSE of
 * its own, and without this it would be demanded as a vendored override — which
 * would be a false claim that our own code is upstream third-party.
 *
 * Falls back to just `root`'s name when no workspace root is found, so a
 * standalone project (and every build fixture in the tests) behaves as before.
 */
function firstPartyNames(root: string): Set<string> {
  const names = new Set<string>();
  const own = readProjectName(root);

  if (own) names.add(own);

  let dir = root;

  for (let depth = 0; depth < WORKSPACE_SEARCH_DEPTH; depth++) {
    const globs = readJson(join(dir, "package.json"))?.workspaces;

    if (Array.isArray(globs)) {
      for (const glob of globs) {
        if (typeof glob !== "string") continue;

        for (const packageDir of expandWorkspaceGlob(dir, glob)) {
          const name = readProjectName(packageDir);
          if (name) names.add(name);
        }
      }
      break;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return names;
}

/** Directory of an installed package, even when its exports hide package.json. */
export function packageDir(name: string, from: string): string {
  const require = createRequire(from);

  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let dir = dirname(require.resolve(name));

    for (;;) {
      const json = readJson(join(dir, "package.json"));
      if (json?.name === name) return dir;

      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }

    throw new Error(`[third-party-licenses] cannot locate the ${name} package`);
  }
}

/**
 * Runtime helpers injected by the build tools. Read from the installed tools,
 * so the versions always match the build that produced the bundle.
 */
export function buildToolEntries(): NoticeEntry[] {
  const viteDir = packageDir("vite", import.meta.url);
  const rolldownDir = packageDir("rolldown", join(viteDir, "package.json"));

  const tools = [
    {
      dir: viteDir,
      // Vite's LICENSE.md appends the licenses of Vite's own bundled deps; keep the core license.
      read: (dir: string) => ({
        text: readFileSync(join(dir, "LICENSE.md"), "utf8").split(/\n# Licenses of bundled dependencies/)[0],
        source: "LICENSE.md in the npm package (core license section)",
      }),
      role: "module preload helper injected into the bundle",
    },
    {
      dir: rolldownDir,
      // Rolldown's interop runtime derives from rollup/esbuild; keep their notices too.
      read: (dir: string) => ({
        text: `${readFileSync(join(dir, "LICENSE"), "utf8")}\n\nTHIRD-PARTY-LICENSE:\n\n${readFileSync(join(dir, "THIRD-PARTY-LICENSE"), "utf8")}`,
        source: "LICENSE and THIRD-PARTY-LICENSE in the npm package",
      }),
      role: "module interop runtime and the modulepreload polyfill injected into the bundle",
    },
  ];

  return tools.map(({ dir, read, role }) => {
    const json = readJson(join(dir, "package.json")) as {
      name: string;
      version: string;
      license: string;
      repository?: unknown;
      homepage?: string;
    };
    const { text, source } = read(dir);
    const licenseText = normalizeText(text);

    if (!licenseText) {
      throw new Error(`[third-party-licenses] ${json.name} ships no license text`);
    }

    return {
      id: `${json.name}@${json.version}`,
      license: json.license,
      repository: repositoryText(json.repository, json.homepage),
      licenseText,
      noticeText: null,
      textSource: source,
      author: null,
      role,
    };
  });
}

/**
 * Walk up from a bundled module to the package.json that owns it.
 * Mirrors how rollup-plugin-license attributes modules.
 */
export function owningPackage(id: string): { id: string; dir: string } | null {
  const clean = id.replace(/^\0/, "");

  if (!isAbsolute(clean) || !clean.split(/[\\/]/).includes("node_modules")) {
    return null;
  }

  let dir = dirname(clean);

  for (;;) {
    const json = readJson(join(dir, "package.json"));

    if (json && typeof json.name === "string" && typeof json.version === "string") {
      return { id: `${json.name}@${json.version}`, dir };
    }

    const parent = dirname(dir);
    // Bundler ids use forward slashes even on Windows, so match either.
    if (parent === dir || !/[\\/]node_modules[\\/]/.test(dir)) break;
    dir = parent;
  }

  return null;
}

/**
 * Copyright headers in the bundled source files themselves, grouped by the
 * package that owns them. Catches vendored third-party code whose notices
 * never reach the package's LICENSE file.
 */
export function sourceNoticesByPackage(moduleIds: Iterable<string>): Map<string, string[]> {
  const byPackage = new Map<string, Set<string>>();

  for (const id of moduleIds) {
    const owner = owningPackage(id);
    if (!owner) continue;

    let header: string;

    try {
      header = readFileSync(id.replace(/^\0/, ""), "utf8").slice(0, HEADER_BYTES);
    } catch {
      continue;
    }

    const notices = copyrightLines(header);
    if (!notices.length) continue;

    const existing = byPackage.get(owner.id) ?? new Set<string>();
    for (const notice of notices) existing.add(notice);
    byPackage.set(owner.id, existing);
  }

  return new Map([...byPackage].map(([id, notices]) => [id, [...notices].sort(byCodePoint)]));
}

function renderSection(entry: NoticeEntry): string {
  const notices = copyrightLines(entry.licenseText, entry.noticeText);
  const extra = (entry.sourceNotices ?? []).filter((line) => !notices.includes(line));

  const copyright = notices.length
    ? notices.map((line) => `  ${line}`).join("\n")
    : `  (no copyright line detected in the license text${
        entry.author ? `; package author: ${entry.author}` : ""
      }; see the full text below)`;

  const parts = [
    RULE,
    entry.id,
    `License: ${entry.license}`,
    `Repository: ${entry.repository}`,
    ...(entry.role ? [`Included for: ${entry.role}`] : []),
    `Copyright:`,
    copyright,
    ...(extra.length
      ? ["Copyright notices in this package's bundled source files:", ...extra.map((line) => `  ${line}`)]
      : []),
    `License text source: ${entry.textSource}`,
    "",
    entry.licenseText,
  ];

  if (entry.noticeText) {
    parts.push("", "NOTICE:", "", entry.noticeText);
  }

  for (const vendored of entry.vendoredTexts ?? []) {
    parts.push(
      "",
      `License of third-party code vendored into this package (${vendored.source}):`,
      `  ${vendored.reason}`,
      "",
      vendored.text
    );
  }

  return parts.join("\n");
}

/**
 * Render the notices file. Throws (failing the build) when a bundled package
 * has no license text and no override or coveredBy mapping.
 */
export function renderNotices(
  dependencies: Dependency[],
  root: string = PROJECT_ROOT,
  tools: NoticeEntry[] = buildToolEntries(),
  sourceNotices: Map<string, string[]> = new Map()
): string {
  const overrides = loadOverrides(root);
  const firstParty = firstPartyNames(root);

  const bundled = dependencies
    .filter((dependency) => dependency.name && !firstParty.has(dependency.name))
    .sort((a, b) => byCodePoint(`${a.name}@${a.version}`, `${b.name}@${b.version}`));

  // Pass 1: each package's own text, or a vendored override.
  const resolved = bundled.map((dependency) => {
    const id = `${dependency.name}@${dependency.version}`;
    const override = overrides[id];

    let licenseText = normalizeText(dependency.licenseText);
    let textSource = "LICENSE file in the npm package";

    if (!licenseText && override?.file) {
      licenseText = normalizeText(readFileSync(join(root, OVERRIDES_DIR, override.file), "utf8"));
      textSource = `${override.source} (git blob ${override.gitBlob}). ${override.reason}`;
    }

    return { dependency, id, override, licenseText, textSource };
  });

  // Pass 2: sub-package manifests covered by another bundled package's license.
  const entries: NoticeEntry[] = resolved.map((item) => {
    const { dependency, id, override } = item;
    let { licenseText, textSource } = item;
    let noticeText = normalizeText(dependency.noticeText);

    if (!licenseText && override?.coveredBy) {
      const parents = resolved.filter(
        (candidate) => candidate !== item && candidate.dependency.name === override.coveredBy && candidate.licenseText
      );
      const parent = parents.find((candidate) => candidate.dependency.version === dependency.version) ?? parents[0];

      if (!parent) {
        throw new Error(
          `[third-party-licenses] ${id} is mapped to ${override.coveredBy}, which is not bundled with a license text.`
        );
      }

      licenseText = parent.licenseText;
      noticeText = noticeText ?? normalizeText(parent.dependency.noticeText);
      textSource = `license of ${parent.id}. ${override.reason}`;
    }

    if (!licenseText) {
      throw new Error(
        `[third-party-licenses] ${id} is bundled but ships no license text. ` +
          `Vendor its upstream LICENSE into ${OVERRIDES_DIR}/ and list it in overrides.json.`
      );
    }

    return {
      id,
      license: String(dependency.license),
      repository: repositoryText(dependency.repository, dependency.homepage),
      licenseText,
      noticeText,
      textSource,
      author: personText(dependency.author),
      sourceNotices: sourceNotices.get(id),
      vendoredTexts: (override?.extraTexts ?? []).map((vendored) => ({
        text: normalizeText(readFileSync(join(root, OVERRIDES_DIR, vendored.file), "utf8")) ?? "",
        source: `${vendored.source} (git blob ${vendored.gitBlob})`,
        reason: vendored.reason,
      })),
    };
  });

  const header = [
    "Barkeep third-party notices",
    "",
    "Every third-party npm package whose code is bundled into this build of the",
    "Barkeep web app, with its license text and copyright notices, followed",
    "by the build tools whose runtime helpers are injected into the bundle.",
    "Generated at build time by rollup-plugin-license (MIT) from the modules in",
    "the shipped JavaScript chunks. Copyright headers found in the bundled",
    "source files are listed per package as well, since packages may vendor",
    "third-party code that their own LICENSE file does not mention.",
    "Barkeep's own code is licensed under Apache-2.0; see LICENSE and NOTICE",
    "in https://github.com/barbarosalagoz/barkeep.",
    "",
    `Bundled packages: ${entries.length}`,
    "",
    ...entries.map((entry) => `  ${entry.id} (${entry.license})`),
    "",
    `Build-tool runtime helpers: ${tools.length}`,
    "",
    ...tools.map((entry) => `  ${entry.id} (${entry.license})`),
  ];

  return [...header, "", ...entries.map(renderSection), ...tools.map(renderSection), RULE, ""].join("\n");
}

export interface ThirdPartyLicensesOptions {
  /** Project root: package.json and build/license-overrides live here. */
  root?: string;
}

/**
 * Vite plugins: the rollup-plugin-license collector plus an emitter that
 * writes third-party-licenses.txt into the build output. In dev, the same
 * URL answers with a short explanation instead of a 404.
 */
export function thirdPartyLicenses(options: ThirdPartyLicensesOptions = {}): Plugin[] {
  const root = options.root ?? PROJECT_ROOT;
  let collected: Dependency[] | null = null;
  /*
   * Modules that contribute bytes to a chunk. A module whose export the
   * bundler inlines (a constant, say) renders nothing and ships nothing, so
   * it must not appear in the notices or trip the completeness check.
   */
  const renderedIds = new Set<string>();

  const collector = license({
    cwd: root,
    thirdParty: {
      // Private sub-package manifests must not bypass the allow-list.
      includePrivate: true,
      multipleVersions: true,
      allow: {
        test: (dependency) => isAllowedLicense(dependency.license),
        failOnUnlicensed: true,
        failOnViolation: true,
      },
      output: (dependencies) => {
        collected = dependencies;
      },
    },
  });

  const collectorRenderChunk = collector.renderChunk as unknown as (
    this: unknown,
    ...args: unknown[]
  ) => unknown;

  return [
    {
      ...collector,
      apply: "build",
      /*
       * Hide the bundler's own virtual helper modules (\0vite/..., rolldown
       * runtime) from the scan: their ids are not real paths, so the upstream
       * plugin would resolve them against process.cwd() and attribute them to
       * whatever package.json happens to sit there. They are credited in the
       * build-tool section instead.
       */
      renderChunk(code: string, chunk: { modules?: Record<string, unknown> }, ...rest: unknown[]) {
        const entries = Object.entries(chunk.modules ?? {});

        for (const [id, module] of entries) {
          if (((module as { renderedLength?: number } | null)?.renderedLength ?? 0) > 0) {
            renderedIds.add(id);
          }
        }

        const modules = Object.fromEntries(entries.filter(([id]) => isAbsolute(id.replace(/^\0/, ""))));

        return collectorRenderChunk.call(this, code, { ...chunk, modules }, ...rest);
      },
    } as Plugin,
    {
      name: "barkeep:third-party-licenses",
      apply: "build",
      generateBundle() {
        if (collected === null) {
          this.error("rollup-plugin-license produced no third-party report");
        }

        const moduleIds = [...renderedIds];
        const sourceNotices = sourceNoticesByPackage(moduleIds);
        const notices = renderNotices(collected, root, buildToolEntries(), sourceNotices);

        /*
         * Fail closed: every node_modules package that contributes bytes to a
         * chunk must be in the report. (JS modules only: CSS does not reach
         * renderChunk.)
         */
        const reported = new Set([...notices.matchAll(/^ {2}(\S+@\S+) \(/gm)].map((match) => match[1]));
        const missing = [
          ...new Set(
            moduleIds
              .map((id) => owningPackage(id)?.id)
              .filter((id): id is string => Boolean(id) && !reported.has(id as string))
          ),
        ];

        if (missing.length) {
          this.error(
            `[third-party-licenses] bundled packages missing from the report: ${missing.join(", ")}`
          );
        }

        this.emitFile({
          type: "asset",
          fileName: THIRD_PARTY_LICENSES_FILE,
          // The BOM makes browsers decode UTF-8 even when a host omits the charset.
          source: String.fromCharCode(0xfeff) + notices,
        });
      },
    },
    {
      name: "barkeep:third-party-licenses-dev",
      apply: "serve",
      configureServer(server) {
        server.middlewares.use(`${server.config.base}${THIRD_PARTY_LICENSES_FILE}`, (_request, response) => {
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end(
            "Third-party license notices are generated by `npm run build` and served " +
              "from the production build (npm run preview, or the deployed site).\n"
          );
        });
      },
    },
  ];
}
