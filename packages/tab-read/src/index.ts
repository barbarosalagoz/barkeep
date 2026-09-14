/*
 * @barkeep/tab-read -- reading a tab from the chain, and presenting it.
 *
 * Shared by @barkeep/mcp (tab_status, close_tab's final spend, the refusal
 * wording) and by the bill, so that both show the same numbers computed the
 * same way. Before this package existed the logic lived in the MCP server's
 * tabs.ts; a second copy for the bill would have drifted.
 *
 * ONE STELLAR SDK VERSION. This package depends on @stellar/stellar-sdk and
 * pins the same range as @barkeep/mcp (^16.3.0, the floor @x402/stellar 2.25.0
 * declares). Every consumer must resolve to that one copy: a value built by
 * one copy of the SDK is not assignable to the same-named type from another
 * (see packages/core/README.md for why @barkeep/core avoids the SDK entirely).
 * @barkeep/web is on 17 today only because of the wallet kit it is about to
 * lose; when the bill replaces it, web moves to the same range. The test in
 * sdk-lockstep.test.ts fails if the two manifests disagree.
 *
 * No Node, no DOM: tsconfig has lib ES2023 and no ambient types, so a Buffer
 * or a window here fails to typecheck rather than failing in the other runtime.
 */

export { TabReader, type ChainRead, type Invocation, type TabReaderConfig } from "./reader.ts";
export { readPayees, readSpend, type Payees, type Spend, type TabReadConfig } from "./read.ts";
export {
  PAYEES_NOT_RESTRICTED,
  allowsAnyPayee,
  describePayees,
  explorerTx,
  reportReceipt,
  type PayeeEnforcement,
  type Receipt,
  type Tab,
} from "./receipts.ts";
export { fromBaseUnits, toBaseUnits, withUnit } from "./units.ts";
export { SECONDS_PER_LEDGER, describeExpiry, describeWindow, ledgersToWindow, windowToLedgers } from "./time.ts";
