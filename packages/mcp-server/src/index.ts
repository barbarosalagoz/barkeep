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
import { z } from "zod";

import { Chain, explorerTx } from "./chain.ts";
import { keypairFromEnv } from "./keys.ts";
import { Store } from "./state.ts";
import { closeTab, openTab, tabStatus, type TabConfig } from "./tabs.ts";
import { loadDeployment } from "./deployment.ts";

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

export function createServer(): McpServer {
  const deployment = loadDeployment();
  const store = new Store();

  const cfg: TabConfig = {
    token: deployment.contracts.token.id,
    tokenDecimals: 7,
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
        limit: z.string().describe('Cap for the window, in token units, e.g. "0.5"'),
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
        "Fetch a paid HTTP resource, settling an x402 challenge against the tab. " +
        "Not implemented yet.",
      inputSchema: {
        url: z.string().describe("The resource to fetch"),
        max_amount: z.string().describe("Most to pay for this one request, in token units"),
        tab_id: z.string().optional().describe("Defaults to the current tab"),
      },
      _meta: REQUIRES_INTERACTION,
    },
    async () =>
      failure(
        new Error(
          "pay_and_fetch is not implemented. The x402 client (@x402/stellar, @x402/fetch) " +
            "is Week 3 in docs/ARCHITECTURE-v2.md §12. open_tab, tab_status and close_tab work."
        )
      )
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
          tx: result.tx,
          explorer: explorerTx(result.tx),
          revoked: "the agent session key is no longer a signer on any context rule",
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
