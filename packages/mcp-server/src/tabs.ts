/*
 * Opening, reading and closing a tab.
 *
 * A tab IS an on-chain context rule: a CallContract(token) rule carrying the
 * agent's session key as its only signer, a spending-limit policy, and an
 * expiry ledger. Opening one adds the rule; closing one removes it. Everything
 * that matters is the chain's; this module's records are a convenience index,
 * and tabStatus deliberately re-reads the chain rather than trusting them.
 */

import { Address, Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";

import type { Chain } from "./chain.ts";
import type { Store, Tab } from "./state.ts";
import { rawEd25519Key } from "./keys.ts";

/** Testnet closes a ledger roughly every 5 seconds. */
export const SECONDS_PER_LEDGER = 5;

export interface TabConfig {
  token: string;
  tokenDecimals: number;
  policyContract: string;
  verifierEd25519: string;
  smartAccount: string;
  /** The Default rule created at construction; admin operations authorise against it. */
  adminContextRuleId: number;
}

/** ISO-8601 duration -> ledgers. Supports the subset a tab window needs. */
export function windowToLedgers(window: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(window.trim());

  if (!m || m.slice(1).every((v) => v === undefined)) {
    throw new Error(
      `window must be an ISO-8601 duration such as PT1H, PT30M or P1D; got "${window}"`
    );
  }

  const [d, h, min, s] = m.slice(1).map((v) => (v ? Number(v) : 0));
  const seconds = d * 86400 + h * 3600 + min * 60 + s;

  if (seconds <= 0) throw new Error(`window must be greater than zero; got "${window}"`);
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_LEDGER));
}

/** Decimal string in token units -> base units, without floating point. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());

  if (!m) throw new Error(`limit must be a positive decimal string; got "${amount}"`);

  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) {
    throw new Error(`limit has more than ${decimals} decimal places: "${amount}"`);
  }

  const value = BigInt(m[1] + frac);
  if (value <= 0n) throw new Error(`limit must be greater than zero; got "${amount}"`);
  return value;
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const s = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals || undefined);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";

  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const tabId = (): string =>
  `tab_${[...crypto.getRandomValues(new Uint8Array(6))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

export interface OpenTabArgs {
  limit: string;
  window: string;
  /**
   * Reserved. Not accepted yet -- see the error thrown below and §4/§10 risk 1.
   * Declared here so that adding enforcement later is additive.
   */
  payees?: string[];
}

export interface OpenTabResult {
  tabId: string;
  contextRuleId: number;
  expiryLedger: number;
  tx: string;
  tab: Tab;
}

export async function openTab(
  chain: Chain,
  store: Store,
  cfg: TabConfig,
  admin: Keypair,
  agent: Keypair,
  args: OpenTabArgs
): Promise<OpenTabResult> {
  /*
   * Refusing `payees` rather than recording it.
   *
   * payee_allowlist is not written, so nothing on chain would restrict a
   * destination. Accepting the list and storing it would produce a tab that
   * reads as constrained to those payees while the agent can in fact pay
   * anyone -- the worst of the options, because it is the one that misleads.
   * The parameter stays in the schema so that adding the policy later is a
   * capability gain and not a breaking change.
   */
  if (args.payees !== undefined) {
    throw new Error(
      "payees is not enforceable yet: the payee_allowlist policy contract is not " +
        "written or deployed, so nothing on chain would restrict destinations. " +
        "Refusing rather than recording a constraint that does not exist. Open the " +
        "tab without payees, and keep the cap small: the amount is capped on chain, " +
        "the destination is not."
    );
  }

  const limitBase = toBaseUnits(args.limit, cfg.tokenDecimals);
  const windowLedgers = windowToLedgers(args.window);
  const expiryLedger = (await chain.latestLedger()) + windowLedgers;

  const result = await chain.send(
    {
      contract: cfg.smartAccount,
      fn: "add_context_rule",
      args: [
        xdr.ScVal.scvVec([
          nativeToScVal("CallContract", { type: "symbol" }),
          new Address(cfg.token).toScVal(),
        ]),
        nativeToScVal("agent", { type: "string" }),
        xdr.ScVal.scvU32(expiryLedger),
        xdr.ScVal.scvVec([
          xdr.ScVal.scvVec([
            nativeToScVal("External", { type: "symbol" }),
            new Address(cfg.verifierEd25519).toScVal(),
            xdr.ScVal.scvBytes(Buffer.from(rawEd25519Key(agent.publicKey()))),
          ]),
        ]),
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: new Address(cfg.policyContract).toScVal(),
            val: nativeToScVal(
              { spending_limit: limitBase, period_ledgers: windowLedgers },
              { type: { spending_limit: ["symbol", "i128"], period_ledgers: ["symbol", "u32"] } }
            ),
          }),
        ]),
      ],
    },
    { signWith: admin, contextRuleId: cfg.adminContextRuleId }
  );

  if (!result.ok) {
    throw new Error(`open_tab failed on chain: ${result.error ?? result.stage}`);
  }

  const rule = result.returnValue as { id?: number } | undefined;
  const contextRuleId = rule?.id;

  if (typeof contextRuleId !== "number") {
    throw new Error("open_tab: the account did not return a context rule id");
  }

  const tab: Tab = {
    tabId: tabId(),
    contextRuleId,
    policyContract: cfg.policyContract,
    token: cfg.token,
    limit: limitBase.toString(),
    windowLedgers,
    expiryLedger,
    agentPublicKey: agent.publicKey(),
    payees: null,
    payeeEnforcement: "none",
    status: "open",
    openedAt: new Date().toISOString(),
    openTx: result.hash!,
  };

  store.putTab(tab);
  store.appendReceipt({ tabId: tab.tabId, at: tab.openedAt, kind: "open", tx: tab.openTx });

  return { tabId: tab.tabId, contextRuleId, expiryLedger, tx: result.hash!, tab };
}

export interface TabStatus {
  tabId: string;
  status: "open" | "closed" | "expired";
  source: "chain";
  limit: string;
  spent: string;
  remaining: string;
  windowLedgers: number;
  expiryLedger: number;
  currentLedger: number;
  ledgersRemaining: number;
  constraints: {
    amount: { enforced: true; by: "on-chain policy"; limit: string; window_ledgers: number };
    payees: { enforced: false; reason: string } | { enforced: true; allowlist: string[] };
  };
  warnings: string[];
  receipts: unknown[];
}

/**
 * Read a tab's numbers FROM THE CHAIN.
 *
 * The stored record supplies only the ids needed to ask. Spend totals come from
 * the policy contract's own rolling-window state, so a transfer made outside
 * this server -- by another client, or by hand -- is reflected here. Local
 * bookkeeping would silently disagree with the thing that actually enforces.
 */
export async function tabStatus(
  chain: Chain,
  store: Store,
  cfg: TabConfig,
  tabIdArg?: string
): Promise<TabStatus> {
  const tab = tabIdArg ? store.getTab(tabIdArg) : store.currentTab();

  if (!tab) {
    throw new Error(tabIdArg ? `no tab with id ${tabIdArg}` : "no open tab");
  }

  const data = (await chain.read({
    contract: tab.policyContract,
    fn: "get_spending_limit_data",
    args: [xdr.ScVal.scvU32(tab.contextRuleId), new Address(cfg.smartAccount).toScVal()],
  })) as { spending_limit: bigint; period_ledgers: number; cached_total_spent: bigint };

  const currentLedger = await chain.latestLedger();
  const limit = BigInt(data.spending_limit);
  const spent = BigInt(data.cached_total_spent);
  const remaining = limit > spent ? limit - spent : 0n;

  const expired = currentLedger > tab.expiryLedger;
  const status: TabStatus["status"] =
    tab.status === "closed" ? "closed" : expired ? "expired" : "open";

  const warnings: string[] = [];
  if (tab.payeeEnforcement === "none") {
    warnings.push(
      "This tab caps HOW MUCH, not WHO TO. No payee allowlist is enforced on chain: " +
        "the agent may send the capped amount to any address."
    );
  }
  if (expired && tab.status === "open") {
    warnings.push(
      `The session key expired at ledger ${tab.expiryLedger}; transfers are refused ` +
        `(Error(Contract, #3002)). The rule still exists until close_tab removes it.`
    );
  }

  return {
    tabId: tab.tabId,
    status,
    source: "chain",
    limit: fromBaseUnits(limit, cfg.tokenDecimals),
    spent: fromBaseUnits(spent, cfg.tokenDecimals),
    remaining: fromBaseUnits(remaining, cfg.tokenDecimals),
    windowLedgers: Number(data.period_ledgers),
    expiryLedger: tab.expiryLedger,
    currentLedger,
    ledgersRemaining: Math.max(0, tab.expiryLedger - currentLedger),
    constraints: {
      amount: {
        enforced: true,
        by: "on-chain policy",
        limit: fromBaseUnits(limit, cfg.tokenDecimals),
        window_ledgers: Number(data.period_ledgers),
      },
      payees: {
        enforced: false,
        reason:
          "payee_allowlist is not written or deployed; no destination restriction exists on chain",
      },
    },
    warnings,
    receipts: store.receipts(tab.tabId),
  };
}

export interface CloseTabResult {
  tabId: string;
  tx: string;
  finalSpent: string;
  tab: Tab;
}

/**
 * Remove the tab's context rule.
 *
 * This is what actually revokes the agent: with the rule gone, the session key
 * is a signer on nothing, and a transfer signed by it is refused with
 * `Error(Contract, #3000)` -- ContextRuleNotFound.
 *
 * Note that this is a DIFFERENT refusal from an expired tab, which gives
 * `Error(Contract, #3002)` (UnvalidatedContext). The distinction is real and
 * worth keeping straight when reading a failure: 3002 means the rule is still
 * there but no longer valid, 3000 means it is gone. Measured, not assumed --
 * an earlier version of this comment claimed 3002 for both.
 */
export async function closeTab(
  chain: Chain,
  store: Store,
  cfg: TabConfig,
  admin: Keypair,
  tabIdArg?: string
): Promise<CloseTabResult> {
  const tab = tabIdArg ? store.getTab(tabIdArg) : store.currentTab();

  if (!tab) throw new Error(tabIdArg ? `no tab with id ${tabIdArg}` : "no open tab");
  if (tab.status === "closed") throw new Error(`${tab.tabId} is already closed`);

  const before = await tabStatus(chain, store, cfg, tab.tabId);

  const result = await chain.send(
    {
      contract: cfg.smartAccount,
      fn: "remove_context_rule",
      args: [xdr.ScVal.scvU32(tab.contextRuleId)],
    },
    { signWith: admin, contextRuleId: cfg.adminContextRuleId }
  );

  if (!result.ok) {
    throw new Error(`close_tab failed on chain: ${result.error ?? result.stage}`);
  }

  const closed: Tab = {
    ...tab,
    status: "closed",
    closedAt: new Date().toISOString(),
    closeTx: result.hash!,
  };

  store.putTab(closed);
  store.appendReceipt({
    tabId: tab.tabId,
    at: closed.closedAt!,
    kind: "close",
    tx: closed.closeTx,
    amount: before.spent,
  });

  return { tabId: tab.tabId, tx: result.hash!, finalSpent: before.spent, tab: closed };
}
