# @barkeep/tab-read

Reading a tab from the chain, and presenting it. Shared by `@barkeep/mcp`
(`tab_status`, `close_tab`'s final spend, the refusal wording) and by the bill
dashboard, so that both show the same numbers computed the same way.

| Module | What |
| --- | --- |
| `src/reader.ts` | `TabReader`: simulate one contract call and return its value. Needs an RPC URL and one *public* key as the simulation's source. Signs nothing. |
| `src/read.ts` | `readSpend` (the spending-limit policy's cap and rolling-window spend) and `readPayees` (the rule's policies, and the allowlist's entries when it carries one) |
| `src/receipts.ts` | The `Tab` and `Receipt` shapes the MCP server writes, `allowsAnyPayee`, `describePayees`, `reportReceipt`, `explorerTx` |
| `src/units.ts` | Base units <-> decimal strings, always with the token's symbol |
| `src/time.ts` | Ledgers <-> ISO-8601 windows, and how an expiry is described |

Nothing here writes: no keys, no submission. The MCP server's `Chain` wraps
`TabReader` for its reads and adds signing on top.

## One Stellar SDK version

This package depends on `@stellar/stellar-sdk` and pins the range `@barkeep/mcp`
uses (`^16.3.0`, the floor `@x402/stellar` 2.25.0 declares). Every consumer must
resolve to that same copy: a value built by one copy of the SDK is not
assignable to the same-named type from another. `packages/core/README.md`
explains the failure; `@barkeep/core` avoids the SDK entirely for that reason,
and this package exists because the tab reads cannot.

`@barkeep/web` is on SDK 17 today only because of the wallet kit it is about to
lose. When the bill replaces the PromptRail app, web moves to `^16.3.0` and
adds this package. `src/sdk-lockstep.test.ts` fails CI if a consumer's range
ever differs, or if npm installs two copies of it.

The root `package.json` lists `@stellar/stellar-sdk: ^16.3.0` as a
devDependency for one reason: with web's 17 hoisted to the root, npm gave this
package and `@barkeep/mcp` a nested 16.3.0 *each* -- same version, two copies,
two type identities. The root entry makes 16.3.0 the hoisted copy; web's 17
nests under `packages/web` instead. Remove the root entry once web is on the
same range.

## No Node, no DOM

`tsconfig.json` has `lib: ["ES2023"]` and no ambient types. A `Buffer`, an
`fs` import or a `window` here fails `npm run typecheck` rather than failing at
runtime on the side that lacks it.
