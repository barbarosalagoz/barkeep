/*
 * The deployed contract addresses, read from deployments/testnet.json.
 *
 * Public ledger addresses, committed to the repo so a deployment is
 * reproducible rather than living in someone's shell history. Nothing here is
 * secret. See docs/DEPLOYMENTS.md.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Deployment {
  network: string;
  networkPassphrase: string;
  rpcUrl: string;
  deployer: string;
  contracts: Record<string, { id: string; symbol?: string; description?: string }>;
}

export function loadDeployment(path?: string): Deployment {
  const file =
    path ??
    process.env.BARKEEP_DEPLOYMENT ??
    fileURLToPath(new URL("../../../deployments/testnet.json", import.meta.url));

  const parsed = JSON.parse(readFileSync(file, "utf8")) as Deployment;

  for (const required of ["smartAccount", "policySpendingLimit", "policyPayeeAllowlist", "verifierEd25519", "token"]) {
    if (!parsed.contracts?.[required]?.id) {
      throw new Error(`${file} is missing contracts.${required}.id`);
    }
  }

  /*
   * Every amount Barkeep reports carries the token's symbol, and the token is
   * described once per output, so a Testnet test asset is never mistaken for
   * USDC. Both come from the deployment record, not from code.
   */
  if (!parsed.contracts.token.symbol || !parsed.contracts.token.description) {
    throw new Error(`${file} is missing contracts.token.symbol or contracts.token.description`);
  }

  if (parsed.network !== "testnet") {
    throw new Error(`refusing a non-testnet deployment (${parsed.network}); Barkeep is testnet only`);
  }

  return parsed;
}
