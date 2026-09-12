# @barkeep/core

SDK-free primitives shared by `@barkeep/web` and `@barkeep/mcp`.

## Hard constraint: no `@stellar/*`, ever

This package must never depend on `@stellar/*` — not in `package.json`, not in
an import, not as a type-only import.

The two consumers deliberately run different Stellar SDK majors:

| Package | `@stellar/stellar-sdk` | Why |
| --- | --- | --- |
| `@barkeep/web` | 17.x | Current; the app was written against it |
| `@barkeep/mcp` | ^16.3.0 | `@x402/stellar` 2.25.0 declares that floor to avoid v17's XDR API rewrite |

npm resolves both, so two distinct copies sit on disk at once. TypeScript types
are structural but **class and branded types from two copies are not
interchangeable**: a value produced by one copy is not assignable where the
other copy's same-named type is expected. If `@barkeep/core` exposed an SDK
type, it would have to pick one copy, and every value crossing the web/mcp
boundary through this package would carry the wrong type identity — the exact
failure `docs/ARCHITECTURE-v2.md` §3.3 warns about.

So core holds only SDK-free primitives: plain constants, the error taxonomy,
receipt types and decimal-string helpers. Anything needing an SDK type belongs
in the consumer that owns that SDK version.

## How it is enforced

`src/no-stellar-dependency.test.ts` fails the build on any violation. It runs in
CI as part of `npm run test:unit`. Three checks:

1. **Manifest** — no `@stellar/*` key in `dependencies`, `devDependencies`,
   `peerDependencies` or `optionalDependencies`.
2. **Source** — no `@stellar/*` module specifier in any `.ts` file in the
   package, across static `import`, `export … from`, dynamic `import()` and
   `require()`. The source scan is what catches an import that resolves only
   because npm hoisted a copy to the workspace root, where no manifest entry
   would exist to catch it.
3. **The guard itself** — asserts the scanner still finds files and the
   specifier parser still matches, so checks 1 and 2 cannot pass vacuously if
   the scan silently breaks.

The test file excludes itself from the source scan, since it necessarily names
the forbidden scope.
