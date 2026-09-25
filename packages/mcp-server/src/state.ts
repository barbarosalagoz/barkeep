/*
 * Where Barkeep keeps what it knows between runs.
 *
 * Location, in order of preference:
 *   1. $BARKEEP_STATE_DIR          -- explicit override, used by the tests
 *   2. $CLAUDE_PLUGIN_DATA/barkeep -- set by the host when Barkeep runs as a
 *                                     Claude Code plugin; survives updates,
 *                                     which is the whole point (§5)
 *   3. $XDG_STATE_HOME/barkeep
 *   4. ~/.local/state/barkeep
 *
 * Not the repository (this is per-machine runtime state, not source, and it
 * would be one bad `git add` from being committed) and not a temp directory
 * (tabs outlive a reboot; a tab whose record vanished is a live on-chain rule
 * nobody can close by id).
 *
 * WHAT IT HOLDS: tab metadata, an append-only receipt log, and the payment
 * records pay_and_fetch uses for idempotency. Public values only -- contract
 * ids, ledger numbers, amounts, transaction hashes, the agent's PUBLIC key, and
 * the (truncated) bodies of resources already paid for.
 *
 * WHAT IT NEVER HOLDS: key material of any kind. The admin and submitter keys
 * come from the environment (keys.ts); per-tab agent keys live in their own
 * directory, next to this one and not inside it (agentKeys.ts). Nothing in this module writes a secret, and
 * `assertNoSecrets` is the test that keeps it that way.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/*
 * The Tab and Receipt shapes are @barkeep/tab-read's, so the bill reads the
 * files this module writes with the same definitions. Re-exported here so
 * the server's modules keep importing them from state.ts.
 */
export { allowsAnyPayee, type PayeeEnforcement, type Receipt, type Tab } from "@barkeep/tab-read";
import type { Receipt, Tab } from "@barkeep/tab-read";

/**
 * One pay_and_fetch request, keyed for idempotency.
 *
 *   pending     the payment signature is about to be, or has been, sent
 *   settled     the seller returned a settlement with a transaction hash
 *   refused     refused before any money could move; safe to try again
 *   unconfirmed a signature went out and no settlement came back; NOT retried
 *               automatically, because it may yet have settled
 */
export interface PaymentRecord {
  key: string;
  tabId: string;
  url: string;
  maxAmount: string;
  requestId: string | null;
  status: "pending" | "settled" | "refused" | "unconfirmed";
  startedAt: string;
  updatedAt: string;
  /** Base units, as the seller asked. */
  amount?: string;
  payTo?: string;
  tx?: string;
  httpStatus?: number;
  body?: string;
  bodyTruncated?: boolean;
  error?: string;
}

export function stateDir(): string {
  const explicit = process.env.BARKEEP_STATE_DIR;
  if (explicit) return explicit;

  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) return join(pluginData, "barkeep");

  const xdg = process.env.XDG_STATE_HOME;
  return xdg ? join(xdg, "barkeep") : join(homedir(), ".local", "state", "barkeep");
}

export class Store {
  readonly dir: string;
  private readonly tabsFile: string;
  private readonly receiptsFile: string;
  private readonly paymentsFile: string;

  constructor(dir: string = stateDir()) {
    this.dir = dir;
    this.tabsFile = join(dir, "tabs.json");
    this.receiptsFile = join(dir, "receipts.jsonl");
    this.paymentsFile = join(dir, "payments.json");
    mkdirSync(dir, { recursive: true });
  }

  listTabs(): Tab[] {
    try {
      return JSON.parse(readFileSync(this.tabsFile, "utf8")) as Tab[];
    } catch {
      return [];
    }
  }

  getTab(tabId: string): Tab | undefined {
    return this.listTabs().find((t) => t.tabId === tabId);
  }

  /** The tab a tool means when the caller does not name one. */
  currentTab(): Tab | undefined {
    const open = this.listTabs().filter((t) => t.status === "open");
    return open[open.length - 1];
  }

  putTab(tab: Tab): void {
    const tabs = this.listTabs().filter((t) => t.tabId !== tab.tabId);

    tabs.push(tab);
    writeFileSync(this.tabsFile, `${JSON.stringify(tabs, null, 2)}\n`);
  }

  /** Append-only: the receipt log is the record, never rewritten in place (§6). */
  appendReceipt(receipt: Receipt): void {
    appendFileSync(this.receiptsFile, `${JSON.stringify(receipt)}\n`);
  }

  receipts(tabId?: string): Receipt[] {
    let lines: string[];
    try {
      lines = readFileSync(this.receiptsFile, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }

    const all = lines.map((l) => JSON.parse(l) as Receipt);
    return tabId ? all.filter((r) => r.tabId === tabId) : all;
  }

  private payments(): Record<string, PaymentRecord> {
    try {
      return JSON.parse(readFileSync(this.paymentsFile, "utf8")) as Record<string, PaymentRecord>;
    } catch {
      return {};
    }
  }

  getPayment(key: string): PaymentRecord | undefined {
    return this.payments()[key];
  }

  putPayment(record: PaymentRecord): void {
    const all = this.payments();

    all[record.key] = record;
    writeFileSync(this.paymentsFile, `${JSON.stringify(all, null, 2)}\n`);
  }
}

/**
 * Everything the store has written, as text. The no-secrets test scans this;
 * exported so the check runs against real files rather than a mock.
 */
export function storedText(dir: string): string {
  const read = (f: string) => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return "";
    }
  };

  return `${read("tabs.json")}\n${read("receipts.jsonl")}\n${read("payments.json")}`;
}
