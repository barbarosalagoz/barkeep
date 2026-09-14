/*
 * A tab's numbers, FROM THE CHAIN.
 *
 * The stored record supplies only the ids needed to ask. The cap and the
 * rolling-window spend come from the spending-limit policy's own state; who
 * the tab can pay comes from the rule's policies and the allowlist's entries.
 * A transfer made outside the server, or a payee the human signer added after
 * open_tab, is therefore reflected. Local bookkeeping would silently disagree
 * with the thing that actually enforces.
 */

import { Address, xdr } from "@stellar/stellar-sdk";

import type { ChainRead } from "./reader.ts";
import type { Tab } from "./receipts.ts";

/** The contracts a read needs, from deployments/testnet.json. */
export interface TabReadConfig {
  smartAccount: string;
  /** contracts/barkeep-payee-allowlist, installed on every tab not opened with allow_any_payee. */
  payeeAllowlistPolicy: string;
}

export interface Spend {
  limit: bigint;
  spent: bigint;
  periodLedgers: number;
}

/** The policy's own record of a tab's cap and rolling-window spend, in base units. */
export async function readSpend(
  chain: ChainRead,
  cfg: Pick<TabReadConfig, "smartAccount">,
  tab: Pick<Tab, "policyContract" | "contextRuleId">
): Promise<Spend> {
  const data = (await chain.read({
    contract: tab.policyContract,
    fn: "get_spending_limit_data",
    args: [xdr.ScVal.scvU32(tab.contextRuleId), new Address(cfg.smartAccount).toScVal()],
  })) as { spending_limit: bigint; period_ledgers: number; cached_total_spent: bigint };

  return { limit: BigInt(data.spending_limit), spent: BigInt(data.cached_total_spent), periodLedgers: Number(data.period_ledgers) };
}

export interface Payees {
  allowAnyPayee: boolean;
  payees: string[] | null;
}

/**
 * Who the tab's rule can pay, read from the chain: the rule's policies, and
 * the allowlist's entries if one is installed. The human signer can change the
 * list after open_tab, so the stored copy is not the answer.
 */
export async function readPayees(
  chain: ChainRead,
  cfg: TabReadConfig,
  tab: Pick<Tab, "contextRuleId">
): Promise<Payees> {
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
