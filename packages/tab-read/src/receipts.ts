/*
 * The tab record and the receipt line, as the MCP server writes them and the
 * bill reads them. The server owns the files (packages/mcp-server/src/state.ts);
 * this is the shape, and how one line is presented.
 */

export type PayeeEnforcement = "none" | "on-chain";

export interface Tab {
  tabId: string;
  /** The on-chain context rule this tab IS. Closing the tab removes it. */
  contextRuleId: number;
  policyContract: string;
  token: string;
  /** Cap in token base units (stroops), as a decimal string. */
  limit: string;
  windowLedgers: number;
  /** The window as requested, ISO-8601 (e.g. PT1H). Absent on tabs opened before it was stored. */
  window?: string;
  expiryLedger: number;
  /** Public key of the agent session signer. Never the secret. */
  agentPublicKey: string;
  /**
   * The payees the tab's rule may transfer to, as installed in the
   * payee-allowlist policy at open time, or null on a tab opened with
   * allow_any_payee. tab_status re-reads the list from the chain; this copy is
   * what was asked for.
   */
  payees: string[] | null;
  payeeEnforcement: PayeeEnforcement;
  /**
   * True when the tab was opened with allow_any_payee: no allowlist on its
   * rule. Absent on tabs opened before the allowlist existed, which could all
   * pay anyone; read it through `allowsAnyPayee`.
   */
  allowAnyPayee?: boolean;
  /** The payee-allowlist policy installed on the rule, when payees is set. */
  payeeAllowlistPolicy?: string;
  status: "open" | "closed";
  openedAt: string;
  openTx: string;
  closedAt?: string;
  closeTx?: string;
}

export interface Receipt {
  tabId: string;
  at: string;
  /**
   * payment      settled; `tx` is the transfer
   * refused      a payment was attempted and did not happen; `reason` and
   *              `refusedBy` say why and who stopped it
   * unconfirmed  a payment signature went out and no settlement came back
   */
  kind: "open" | "close" | "payment" | "refused" | "unconfirmed";
  /** Decimal token units. On refused/unconfirmed, the price that was asked. */
  amount?: string;
  /** Token symbol the amount is in. Absent on receipts written before it was recorded. */
  asset?: string;
  to?: string;
  tx?: string;
  /** The URL paid for, on payment, refused and unconfirmed receipts. */
  endpoint?: string;
  reason?: string;
  refusedBy?: "on-chain policy" | "per-call cap" | "seller's facilitator" | "payment terms" | "signing";
  note?: string;
  /**
   * The tab's allow_any_payee at the time of writing, on every receipt, so a
   * line of the bill says on its own whether its payee was restricted. Absent
   * on receipts written before the allowlist existed.
   */
  allowAnyPayee?: boolean;
}

/** Whether a tab can pay anyone. Tabs from before the allowlist could. */
export const allowsAnyPayee = (tab: Pick<Tab, "allowAnyPayee" | "payeeEnforcement">): boolean =>
  tab.allowAnyPayee ?? tab.payeeEnforcement !== "on-chain";

/** Who a tab can pay, worded once for open_tab, tab_status and the bill. */
export const PAYEES_NOT_RESTRICTED =
  "Not restricted: this tab was opened with allow_any_payee. The cap limits how much it can spend, not who it pays.";

export const describePayees = (tab: Pick<Tab, "payeeEnforcement" | "payees" | "allowAnyPayee">): string =>
  allowsAnyPayee(tab) || !tab.payees
    ? PAYEES_NOT_RESTRICTED
    : `Restricted on chain to: ${tab.payees.join(", ")}. The payee-allowlist policy refuses a transfer to anyone else ` +
      `(Error(Contract, #3901)); only the human signer can change the list.`;

/**
 * A stored receipt as tab_status and the bill report it: snake_case, and the
 * amount joined with its asset. The log on disk keeps its own shape; this is
 * presentation.
 *
 * allow_any_payee is on every line. A receipt written before the allowlist
 * existed did not record it; `tab` supplies the tab's value for those.
 */
export function reportReceipt(
  r: Receipt,
  cfg: { tokenSymbol: string },
  tab?: Pick<Tab, "payeeEnforcement" | "allowAnyPayee">
): Record<string, unknown> {
  const out: Record<string, unknown> = { at: r.at, kind: r.kind };
  if (r.amount !== undefined) out.amount = `${r.amount} ${r.asset ?? cfg.tokenSymbol}`;
  if (r.endpoint !== undefined) out.endpoint = r.endpoint;
  if (r.to !== undefined) out.to = r.to;
  if (r.tx !== undefined) out.tx = r.tx;
  if (r.refusedBy !== undefined) out.refused_by = r.refusedBy;
  if (r.reason !== undefined) out.reason = r.reason;
  if (r.note !== undefined) out.note = r.note;
  const allowAny = r.allowAnyPayee ?? (tab ? allowsAnyPayee(tab) : undefined);
  if (allowAny !== undefined) out.allow_any_payee = allowAny;
  return out;
}

export const explorerTx = (hash: string): string =>
  `https://stellar.expert/explorer/testnet/tx/${hash}`;
