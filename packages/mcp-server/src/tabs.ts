/*
 * Opening, reading and closing a tab.
 *
 * A tab IS an on-chain context rule: a CallContract(token) rule carrying the
 * agent's session key as its only signer, a spending-limit policy, a
 * payee-allowlist policy (unless opened with allow_any_payee), and an expiry
 * ledger. Opening one adds the rule; closing one removes it. Everything that
 * matters is the chain's; this module's records are a convenience index, and
 * tabStatus deliberately re-reads the chain rather than trusting them.
 */

import { Address, Keypair, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

import type { Chain } from "./chain.ts";
import { allowsAnyPayee, type Receipt, type Store, type Tab } from "./state.ts";
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
  /** contracts/barkeep-payee-allowlist, installed on every tab not opened with allow_any_payee. */
  payeeAllowlistPolicy: string;
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

/** Ledgers -> an ISO-8601 duration at SECONDS_PER_LEDGER, for tabs that predate storing `window`. */
export function ledgersToWindow(ledgers: number): string {
  let s = ledgers * SECONDS_PER_LEDGER;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
  const iso = `P${d ? `${d}D` : ""}${time ? `T${time}` : ""}`;
  return iso === "P" ? "PT0S" : iso;
}

/** "PT1H (720 ledgers)": the window as asked, and what the chain counts. */
export const describeWindow = (window: string | undefined, ledgers: number): string =>
  `${window ?? ledgersToWindow(ledgers)} (${ledgers} ledgers)`;

/** "at ledger 4653477, in ~60 min (716 ledgers)", or how long ago it passed. */
export function describeExpiry(expiryLedger: number, currentLedger: number): string {
  const left = expiryLedger - currentLedger;
  const minutes = Math.round((Math.abs(left) * SECONDS_PER_LEDGER) / 60);
  return left >= 0
    ? `at ledger ${expiryLedger}, in ~${minutes} min (${left} ledgers)`
    : `at ledger ${expiryLedger}, ~${minutes} min ago (${-left} ledgers)`;
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
  /** Who the tab may pay, enforced on chain by the payee-allowlist policy. */
  payees?: string[];
  /** Must be exactly `true` to open a tab with no allowlist. */
  allow_any_payee?: boolean;
}

/** The payee-allowlist policy's own cap (MAX_PAYEES in the contract). */
export const MAX_PAYEES = 20;

/**
 * What open_tab will install for payees, or why it refuses.
 *
 * FAIL CLOSED. An absent or empty list is not "anyone": it is refused unless
 * the caller says allow_any_payee: true, in so many words. The contract refuses
 * an empty list too (3902), but it cannot refuse a rule that simply lacks the
 * policy -- that is what allow_any_payee builds -- so the absent case is caught
 * here, before anything is signed.
 */
export function payeeSelection(args: Pick<OpenTabArgs, "payees" | "allow_any_payee">): { payees: string[] | null; allowAnyPayee: boolean } {
  const payees = args.payees ?? [];

  if (args.allow_any_payee === true) {
    if (payees.length > 0) {
      throw new Error(
        "open_tab refused: payees and allow_any_payee: true contradict each other. Pass payees to restrict " +
          "this tab on chain, or allow_any_payee: true with no payees. Nothing was sent."
      );
    }
    return { payees: null, allowAnyPayee: true };
  }

  if (payees.length === 0) {
    throw new Error(
      "open_tab refused: no payees, and allow_any_payee is not true. An empty or absent payee list does not " +
        "mean anyone. Pass payees (G... or C... addresses) to restrict who this tab can pay, enforced on chain, " +
        "or allow_any_payee: true to open a tab that can pay anyone up to its cap. Nothing was sent."
    );
  }

  if (payees.length > MAX_PAYEES) {
    throw new Error(`open_tab refused: ${payees.length} payees; the allowlist holds at most ${MAX_PAYEES}. Nothing was sent.`);
  }

  const cleaned = payees.map((p) => p.trim());
  for (const p of cleaned) {
    if (StrKey.isValidMed25519PublicKey(p)) {
      throw new Error(
        `open_tab refused: ${p} is a muxed (M...) address. The allowlist matches the transfer's destination ` +
          "exactly and refuses muxed destinations; list the underlying G... account. Nothing was sent."
      );
    }
    if (!StrKey.isValidEd25519PublicKey(p) && !StrKey.isValidContract(p)) {
      throw new Error(`open_tab refused: "${p}" is not a Stellar account (G...) or contract (C...) address. Nothing was sent.`);
    }
  }

  const duplicate = cleaned.find((p, i) => cleaned.indexOf(p) !== i);
  if (duplicate) throw new Error(`open_tab refused: ${duplicate} is listed twice. Nothing was sent.`);

  return { payees: cleaned, allowAnyPayee: false };
}

/*
 * A Soroban map must reach the host with its keys in ascending order, or the
 * host refuses the value. Policy addresses are all contracts, which order by
 * their 32-byte ids.
 */
const policyMap = (entries: [string, xdr.ScVal][]): xdr.ScVal =>
  xdr.ScVal.scvMap(
    entries
      .map(([id, val]) => ({ key: StrKey.decodeContract(id), id, val }))
      .sort((a, b) => Buffer.compare(a.key, b.key))
      .map(({ id, val }) => new xdr.ScMapEntry({ key: new Address(id).toScVal(), val }))
  );

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
  // Every refusal about payees happens here, before a ledger is even read.
  const { payees, allowAnyPayee } = payeeSelection(args);

  const limitBase = toBaseUnits(args.limit, cfg.tokenDecimals);
  const windowLedgers = windowToLedgers(args.window);
  const expiryLedger = (await chain.latestLedger()) + windowLedgers;

  const policies: [string, xdr.ScVal][] = [
    [
      cfg.policyContract,
      nativeToScVal(
        { spending_limit: limitBase, period_ledgers: windowLedgers },
        { type: { spending_limit: ["symbol", "i128"], period_ledgers: ["symbol", "u32"] } }
      ),
    ],
  ];

  if (payees) {
    policies.push([
      cfg.payeeAllowlistPolicy,
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("payees"),
          val: xdr.ScVal.scvVec(payees.map((p) => new Address(p).toScVal())),
        }),
      ]),
    ]);
  }

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
        policyMap(policies),
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
    payees,
    payeeEnforcement: payees ? "on-chain" : "none",
    allowAnyPayee,
    ...(payees ? { payeeAllowlistPolicy: cfg.payeeAllowlistPolicy } : {}),
    status: "open",
    openedAt: new Date().toISOString(),
    openTx: result.hash!,
  };

  store.putTab(tab);
  store.appendReceipt({ tabId: tab.tabId, at: tab.openedAt, kind: "open", tx: tab.openTx, allowAnyPayee });

  return { tabId: tab.tabId, contextRuleId, expiryLedger, tx: result.hash!, tab };
}

/**
 * snake_case, like every other tool's output. Order is reading order: the
 * numbers, then the bill, then who the tab can pay, last.
 */
export interface TabStatus {
  tab_id: string;
  status: "open" | "closed" | "expired";
  limit: string;
  spent: string;
  remaining: string;
  token: string;
  /** "PT1H (720 ledgers)" */
  window: string;
  /** "at ledger N, in ~M min (L ledgers)" */
  expires: string;
  /** Only conditions that change, e.g. an expired tab. Absent when there are none. */
  warnings?: string[];
  receipts: Record<string, unknown>[];
  /** True when nothing on chain restricts who this tab pays. */
  allow_any_payee: boolean;
  payees: string;
}

/** Who a tab can pay, worded once for open_tab and tab_status. */
export const PAYEES_NOT_RESTRICTED =
  "Not restricted: this tab was opened with allow_any_payee. The cap limits how much it can spend, not who it pays.";

export const describePayees = (tab: Pick<Tab, "payeeEnforcement" | "payees" | "allowAnyPayee">): string =>
  allowsAnyPayee(tab) || !tab.payees
    ? PAYEES_NOT_RESTRICTED
    : `Restricted on chain to: ${tab.payees.join(", ")}. The payee-allowlist policy refuses a transfer to anyone else ` +
      `(Error(Contract, #3901)); only the human signer can change the list.`;

/**
 * A stored receipt as tab_status reports it: snake_case, and the amount joined
 * with its asset. The log on disk keeps its own shape; this is presentation.
 *
 * allow_any_payee is on every line. A receipt written before the allowlist
 * existed did not record it; `tab` supplies the tab's value for those.
 */
export function reportReceipt(
  r: Receipt,
  cfg: Pick<TabConfig, "tokenSymbol">,
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

/**
 * Who the tab's rule can pay, read from the chain: the rule's policies, and
 * the allowlist's entries if one is installed. The human signer can change the
 * list after open_tab, so the stored copy is not the answer.
 */
export async function readPayees(
  chain: Chain,
  cfg: TabConfig,
  tab: Pick<Tab, "contextRuleId">
): Promise<{ allowAnyPayee: boolean; payees: string[] | null }> {
  const rule = (await chain.read({
    contract: cfg.smartAccount,
    fn: "get_context_rule",
    args: [xdr.ScVal.scvU32(tab.contextRuleId)],
  })) as { policies: string[] };

  if (!rule.policies.includes(cfg.payeeAllowlistPolicy)) return { allowAnyPayee: true, payees: null };

  const payees = (await chain.read({
    contract: cfg.payeeAllowlistPolicy,
    fn: "get_payees",
    args: [xdr.ScVal.scvU32(tab.contextRuleId), new Address(cfg.smartAccount).toScVal()],
  })) as string[];

  return { allowAnyPayee: false, payees };
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

  const [{ limit, spent, periodLedgers }, currentLedger, onChain] = await Promise.all([
    readSpend(chain, cfg, tab),
    chain.latestLedger(),
    // A closed tab's rule is gone; what it could pay is what it was opened with.
    tab.status === "closed" ? null : readPayees(chain, cfg, tab),
  ]);
  const remaining = limit > spent ? limit - spent : 0n;

  const expired = currentLedger > tab.expiryLedger;
  const status: TabStatus["status"] =
    tab.status === "closed" ? "closed" : expired ? "expired" : "open";

  const warnings: string[] = [];
  if (expired && tab.status === "open") {
    warnings.push(
      `The session key expired at ledger ${tab.expiryLedger}; transfers are refused ` +
        `(Error(Contract, #3002)). The rule still exists until close_tab removes it.`
    );
  }

  const payeesNow = onChain
    ? { ...tab, allowAnyPayee: onChain.allowAnyPayee, payeeEnforcement: onChain.allowAnyPayee ? ("none" as const) : ("on-chain" as const), payees: onChain.payees }
    : tab;

  if (onChain && onChain.allowAnyPayee !== allowsAnyPayee(tab)) {
    warnings.push(
      onChain.allowAnyPayee
        ? `This tab was recorded as restricted to ${tab.payees?.join(", ")}, but its rule on chain has no payee allowlist: it can pay anyone.`
        : "This tab was recorded as allow_any_payee, but its rule on chain carries a payee allowlist; the chain's list is shown."
    );
  }

  return {
    tab_id: tab.tabId,
    status,
    limit: withUnit(limit, cfg),
    spent: withUnit(spent, cfg),
    remaining: withUnit(remaining, cfg),
    token: cfg.tokenDescription,
    window: describeWindow(tab.window, periodLedgers),
    expires: describeExpiry(tab.expiryLedger, currentLedger),
    ...(warnings.length ? { warnings } : {}),
    // tab_id is the tab's, stated above; each receipt omits it.
    receipts: store.receipts(tab.tabId).map((r) => reportReceipt(r, cfg, tab)),
    allow_any_payee: allowsAnyPayee(payeesNow),
    payees: describePayees(payeesNow),
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
    allowAnyPayee: allowsAnyPayee(tab),
  });

  const otherRules = await rulesListingKey(chain, cfg.smartAccount, tab.agentPublicKey).catch(
    (error: Error) => ({ error: error.message })
  );

  return { tabId: tab.tabId, tx: result.hash!, finalSpent: withUnit(before.spent, cfg), tab: closed, otherRules };
}
