/*
 * Opening, reading and closing a tab.
 *
 * A tab IS an on-chain context rule: a CallContract(token) rule carrying the
 * agent's session key as its only signer, a spending-limit policy, and an
 * expiry ledger. Opening one adds the rule; closing one removes it. Everything
 * that matters is the chain's; this module's records are a convenience index,
 * and tabStatus deliberately re-reads the chain rather than trusting them.
 */

import { Address, Keypair, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import type { Chain } from "./chain.ts";
import type { Store, Tab } from "./state.ts";
import { rawEd25519Key } from "./keys.ts";

/** Testnet closes a ledger roughly every 5 seconds. */
export const SECONDS_PER_LEDGER = 5;

export interface TabConfig {
  token: string;
  tokenDecimals: number;
  /** Carried by every reported amount, e.g. "TAB". */
  tokenSymbol: string;
  /** One sentence saying what the token is; shown once per output. */
  tokenDescription: string;
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
export function toBaseUnits(amount: string, decimals: number, label = "limit"): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());

  if (!m) throw new Error(`${label} must be a positive decimal string; got "${amount}"`);

  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) {
    throw new Error(`${label} has more than ${decimals} decimal places: "${amount}"`);
  }

  const value = BigInt(m[1] + frac);
  if (value <= 0n) throw new Error(`${label} must be greater than zero; got "${amount}"`);
  return value;
}

/** An amount with its token symbol: "0.0001 TAB". */
export const withUnit = (value: bigint, cfg: Pick<TabConfig, "tokenDecimals" | "tokenSymbol">): string =>
  `${fromBaseUnits(value, cfg.tokenDecimals)} ${cfg.tokenSymbol}`;

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
    window: args.window.trim(),
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
  token: string;
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

/** The policy's own record of a tab's cap and rolling-window spend, in base units. */
export async function readSpend(
  chain: Chain,
  cfg: TabConfig,
  tab: Pick<Tab, "policyContract" | "contextRuleId">
): Promise<{ limit: bigint; spent: bigint; periodLedgers: number }> {
  const data = (await chain.read({
    contract: tab.policyContract,
    fn: "get_spending_limit_data",
    args: [xdr.ScVal.scvU32(tab.contextRuleId), new Address(cfg.smartAccount).toScVal()],
  })) as { spending_limit: bigint; period_ledgers: number; cached_total_spent: bigint };

  return { limit: BigInt(data.spending_limit), spent: BigInt(data.cached_total_spent), periodLedgers: Number(data.period_ledgers) };
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

  const [{ limit, spent, periodLedgers }, currentLedger] = await Promise.all([
    readSpend(chain, cfg, tab),
    chain.latestLedger(),
  ]);
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
    limit: withUnit(limit, cfg),
    spent: withUnit(spent, cfg),
    remaining: withUnit(remaining, cfg),
    token: cfg.tokenDescription,
    windowLedgers: periodLedgers,
    expiryLedger: tab.expiryLedger,
    currentLedger,
    ledgersRemaining: Math.max(0, tab.expiryLedger - currentLedger),
    constraints: {
      amount: {
        enforced: true,
        by: "on-chain policy",
        limit: withUnit(limit, cfg),
        window_ledgers: periodLedgers,
      },
      payees: {
        enforced: false,
        reason:
          "payee_allowlist is not written or deployed; no destination restriction exists on chain",
      },
    },
    warnings,
    // Receipts store amount and asset apart; the report joins them.
    receipts: store.receipts(tab.tabId).map(({ amount, asset, ...rest }) =>
      amount === undefined ? rest : { ...rest, amount: `${amount} ${asset ?? cfg.tokenSymbol}` }
    ),
  };
}

export interface RuleListingKey {
  id: number;
  name: string;
  validUntil: number | null;
  expired: boolean;
}

export interface CloseTabResult {
  tabId: string;
  tx: string;
  /** With its token symbol. */
  finalSpent: string;
  tab: Tab;
  /**
   * Other rules on the account that still list the agent key, read from the
   * chain after the removal -- or why that could not be checked.
   */
  otherRules: { checkedRules: number; listing: RuleListingKey[] } | { error: string };
}

/** The account's next context-rule id, read from its instance storage. Ids are never reused. */
async function nextContextRuleId(chain: Chain, account: string): Promise<number> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(account).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  );
  const { entries } = await chain.server.getLedgerEntries(key);
  const wanted = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("NextId")]).toXDR("base64");
  const entry = entries[0]?.val.contractData().val().instance().storage()?.find((e) => e.key().toXDR("base64") === wanted);

  if (!entry) throw new Error("the account's instance storage has no NextId");
  return Number(scValToNative(entry.val()));
}

/**
 * Every live-or-expired context rule on the account that lists `agentPublicKey`
 * as an External signer. The contract has no list call, so this probes each
 * id below NextId; a removed id answers Error(Contract, #3000) and is skipped.
 * Any other failure throws, rather than being mistaken for "not there".
 */
export async function rulesListingKey(
  chain: Chain,
  account: string,
  agentPublicKey: string
): Promise<{ checkedRules: number; listing: RuleListingKey[] }> {
  const agentKey = Buffer.from(rawEd25519Key(agentPublicKey)).toString("hex");
  const [nextId, currentLedger] = await Promise.all([nextContextRuleId(chain, account), chain.latestLedger()]);

  type Rule = { id: number; name: string; valid_until?: number | null; signers: [string, string, Uint8Array?][] };
  const rules: Rule[] = [];

  for (let start = 0; start < nextId; start += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, nextId - start) }, (_, i) => start + i).map((id) =>
        chain.read({ contract: account, fn: "get_context_rule", args: [xdr.ScVal.scvU32(id)] }).then(
          (rule) => rule as Rule,
          (error: Error) => {
            if (/Error\(Contract, #3000\)/.test(error.message)) return null;
            throw error;
          }
        )
      )
    );
    rules.push(...batch.filter((r): r is Rule => r !== null));
  }

  const listing = rules
    .filter((rule) =>
      rule.signers.some(([kind, , keyData]) => kind === "External" && keyData && Buffer.from(keyData).toString("hex") === agentKey)
    )
    .map((rule) => {
      const validUntil = rule.valid_until ?? null;
      // The account rejects a rule once valid_until < the current ledger (UnvalidatedContext, #3002).
      return { id: Number(rule.id), name: rule.name, validUntil, expired: validUntil !== null && validUntil < currentLedger };
    });

  return { checkedRules: rules.length, listing };
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

  const before = await readSpend(chain, cfg, tab);

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
    amount: fromBaseUnits(before.spent, cfg.tokenDecimals),
    asset: cfg.tokenSymbol,
  });

  const otherRules = await rulesListingKey(chain, cfg.smartAccount, tab.agentPublicKey).catch(
    (error: Error) => ({ error: error.message })
  );

  return { tabId: tab.tabId, tx: result.hash!, finalSpent: withUnit(before.spent, cfg), tab: closed, otherRules };
}
