#!/usr/bin/env node
/*
 * Barkeep -- an MCP server for Claude Code.
 *
 * A local stdio server exposing the tab: open one with a spending cap and a
 * time window, spend against it, read what it has spent, close it. The cap is
 * enforced by an on-chain policy, not here.
 *
 * What this server does NOT enforce is the point. It holds no funds, and a
 * compromised or simply buggy build of it still cannot exceed the window: the
 * context rule and the spending-limit policy are the limit (§5). Treat every
 * number this server reports as a convenience and every refusal it issues as
 * advisory -- the authoritative refusals come back as Error(Contract, #NNNN).
 *
 * Testnet only.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client } from "@x402/core/client";
import { z } from "zod";

import { Chain, explorerTx } from "./chain.ts";
import { keypairFromEnv } from "./keys.ts";
import { createPayer } from "./pay.ts";
import { Store } from "./state.ts";
import { closeTab, openTab, tabStatus, withUnit, type CloseTabResult, type RuleListingKey, type TabConfig } from "./tabs.ts";
import { loadDeployment } from "./deployment.ts";
import { X402_NETWORK, smartAccountExactScheme } from "./x402Scheme.ts";

/*
 * Money tools carry requiresUserInteraction, which forces a decision on every
 * call: allow-rules do not skip it and it still prompts under
 * bypass-permissions (§5). v1 sets it on pay_and_fetch too; unattended mode is
 * a later opt-in with a smaller cap.
 */
const REQUIRES_INTERACTION = { "anthropic/requiresUserInteraction": true } as const;

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const failure = (error: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: String((error as Error)?.message ?? error) }],
});

/**
 * What the chain says about the agent key after a close, in one sentence. It
 * states what was checked; it never claims the key is gone from the account
 * unless every rule was read and none lists it.
 */
export function describeOtherRules(other: CloseTabResult["otherRules"]): string {
  if ("error" in other) {
    return `Not checked (${other.error}). The agent key may still be a signer on other rules on this account.`;
  }

  const live = other.listing.filter((r) => !r.expired);
  const expired = other.listing.filter((r) => r.expired);
  const ids = (rules: RuleListingKey[]) => rules.map((r) => r.id).join(", ");

  if (live.length > 0) {
    return (
      `WARNING: the agent key is still a signer on ${live.length} live rule(s) (${ids(live)}) and can still spend through them. ` +
      (expired.length ? `It is also on ${expired.length} expired rule(s) (${ids(expired)}).` : "")
    ).trim();
  }

  if (expired.length > 0) {
    return (
      `The agent key is still listed on ${expired.length} other rule(s) (${ids(expired)}), all expired, so none can authorise a spend ` +
      `(Error(Contract, #3002), UnvalidatedContext). Checked all ${other.checkedRules} rules on the account.`
    );
  }

  return `The agent key is on no other rule. Checked all ${other.checkedRules} rules on the account.`;
}

export function createServer(): McpServer {
  const deployment = loadDeployment();
  const store = new Store();

  const cfg: TabConfig = {
    token: deployment.contracts.token.id,
    tokenDecimals: 7,
    tokenSymbol: deployment.contracts.token.symbol!,
    tokenDescription: deployment.contracts.token.description!,
    policyContract: deployment.contracts.policySpendingLimit.id,
    verifierEd25519: deployment.contracts.verifierEd25519.id,
    smartAccount: deployment.contracts.smartAccount.id,
    adminContextRuleId: 0,
  };

  /* Keys are read lazily so the server starts, and lists its tools, without
   * any secret in the environment. Only the tools that sign need them. */
  const chain = () =>
    new Chain(
      {
        rpcUrl: deployment.rpcUrl,
        networkPassphrase: deployment.networkPassphrase,
        smartAccount: cfg.smartAccount,
        verifierEd25519: cfg.verifierEd25519,
      },
      keypairFromEnv("BARKEEP_SUBMITTER_SECRET")
    );

  const payer = createPayer({
    store,
    fetch: globalThis.fetch,
    tokenDecimals: cfg.tokenDecimals,
    tokenSymbol: cfg.tokenSymbol,
    tokenDescription: cfg.tokenDescription,
    createPayload: async (tab, maxAmount, paymentRequired) => {
      const agent = keypairFromEnv("BARKEEP_AGENT_SECRET");
      if (agent.publicKey() !== tab.agentPublicKey) {
        throw new Error(`${tab.tabId} was opened for agent ${tab.agentPublicKey}, not ${agent.publicKey()}`);
      }

      const scheme = smartAccountExactScheme(chain(), {
        agent,
        contextRuleId: tab.contextRuleId,
        token: tab.token,
        maxAmount,
      });

      // x402's own spend controls, set to the same per-call cap: a second, independent check.
      const client = x402Client.fromConfig({
        schemes: [{ network: X402_NETWORK, client: scheme }],
        spendControls: {
          allowedAssets: [{ network: X402_NETWORK, asset: tab.token, maxAmountPerPayment: maxAmount.toString() }],
        },
      });
      return client.createPaymentPayload(paymentRequired);
    },
  });

  const server = new McpServer(
    { name: "barkeep", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "open_tab",
    {
      title: "Open a tab",
      description:
        "Open a spending tab: creates an on-chain context rule holding the agent's " +
        "session key, a spending-limit policy and an expiry. Returns a tab id and the " +
        "transaction hash. The cap limits how much, not who to.",
      inputSchema: {
        limit: z.string().describe(`Cap for the window, in ${cfg.tokenSymbol} (${cfg.tokenDescription}) e.g. "0.5"`),
        window: z.string().describe('Rolling window as an ISO-8601 duration, e.g. "PT1H"'),
        payees: z
          .array(z.string())
          .optional()
          .describe(
            "NOT YET ENFORCEABLE. Reserved for the payee_allowlist policy, which is " +
              "not written. Passing it is refused rather than silently ignored."
          ),
      },
      _meta: REQUIRES_INTERACTION,
    },
    async (args) => {
      try {
        const result = await openTab(
          chain(),
          store,
          cfg,
          keypairFromEnv("BARKEEP_ADMIN_SECRET"),
          keypairFromEnv("BARKEEP_AGENT_SECRET"),
          args
        );

        return text({
          tab_id: result.tabId,
          limit: withUnit(BigInt(result.tab.limit), cfg),
          token: cfg.tokenDescription,
          context_rule_id: result.contextRuleId,
          policy: cfg.policyContract,
          expiry_ledger: result.expiryLedger,
          tx: result.tx,
          explorer: explorerTx(result.tx),
          payee_enforcement: "none",
          warning:
            "The amount is capped on chain; the destination is not. Any address can be paid.",
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "pay_and_fetch",
    {
      title: "Pay for an HTTP resource",
      description:
        "Fetch a URL; if it answers 402 with an x402 exact challenge on stellar:testnet in the " +
        "tab's token, pay it from the tab's smart account and return the paid response. " +
        "WHO THIS CAN PAY: only sellers whose x402 facilitator accepts smart-account payers, " +
        "such as Barkeep's own facilitator. It does NOT pay arbitrary x402 endpoints today: the " +
        "public facilitator (x402.org) refuses smart-account payments, because its event check " +
        "rejects the spending-limit policy's on-chain event and its fee ceiling is below what a " +
        "smart-account transfer costs. Such sellers refuse the payment and nothing is paid. " +
        "max_amount caps this one call; the tab's cap is enforced on chain. Identical calls " +
        "(same tab, url, max_amount and request_id) pay once and return the stored result.",
      inputSchema: {
        url: z.string().describe("The resource to fetch"),
        max_amount: z.string().describe(`Most to pay for this one request, in ${cfg.tokenSymbol}, e.g. "0.01"`),
        tab_id: z.string().optional().describe("Defaults to the current tab"),
        request_id: z
          .string()
          .optional()
          .describe(
            "Idempotency discriminator. Omit it and a repeat of the same call returns the first " +
              "result without paying again; pass a new value to pay the same URL again deliberately."
          ),
      },
      _meta: REQUIRES_INTERACTION,
    },
    async (args) => {
      try {
        const tab = args.tab_id ? store.getTab(args.tab_id) : store.currentTab();
        if (!tab) throw new Error(args.tab_id ? `no tab with id ${args.tab_id}` : "no open tab");

        return text(await payer(tab, args));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "tab_status",
    {
      title: "Read a tab",
      description:
        "Limit, spent and remaining for a tab, read from the chain rather than local " +
        "state, so spending done outside this server is included. Also reports which " +
        "constraints are actually enforced.",
      inputSchema: {
        tab_id: z.string().optional().describe("Defaults to the current tab"),
      },
    },
    async ({ tab_id }) => {
      try {
        return text(await tabStatus(chain(), store, cfg, tab_id));
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "close_tab",
    {
      title: "Close a tab",
      description:
        "Remove the tab's context rule, revoking the agent session key. After this the " +
        "key can no longer transfer: the chain refuses it with Error(Contract, #3000), " +
        "ContextRuleNotFound. An expired tab is a different refusal, #3002.",
      inputSchema: {
        tab_id: z.string().optional().describe("Defaults to the current tab"),
      },
      _meta: REQUIRES_INTERACTION,
    },
    async ({ tab_id }) => {
      try {
        const result = await closeTab(
          chain(),
          store,
          cfg,
          keypairFromEnv("BARKEEP_ADMIN_SECRET"),
          tab_id
        );

        return text({
          tab_id: result.tabId,
          final_spent: result.finalSpent,
          token: cfg.tokenDescription,
          tx: result.tx,
          explorer: explorerTx(result.tx),
          revoked: `Rule ${result.tab.contextRuleId}, this tab's rule, is removed: the agent key can no longer spend through this tab.`,
          agent_key_on_other_rules: describeOtherRules(result.otherRules),
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}

/* Entry point: only when run directly, so tests can import createServer. */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
