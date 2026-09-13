/*
 * A standalone x402 seller for demos: run it, leave it running between takes.
 *
 * Its facilitator is Barkeep's (facilitator.ts), reached over HTTP through
 * @x402/core's HTTPFacilitatorClient -- the same wire any seller uses. It
 * charges in the tab's token (TAB on Testnet) and is paid to a persistent
 * account, barkeep-testnet-seller in the Stellar CLI's key store.
 *
 * It sets itself up idempotently at every start: if the account has no TAB
 * trustline it adds one. It refuses to start if the facilitator does not answer
 * /supported with exact on stellar:testnet, so a take never begins against a
 * facilitator that is down.
 *
 *   BARKEEP_SELLER_SECRET=$(stellar keys secret barkeep-testnet-seller) \
 *   npx tsx packages/mcp-server/src/seller.ts
 *
 *   BARKEEP_FACILITATOR_URL  default http://127.0.0.1:4020
 *   BARKEEP_SELLER_PORT      default 4021
 *
 * Testnet only; the key authorises nothing but its own trustline.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { Asset, BASE_FEE, Horizon, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";

import { loadDeployment } from "./deployment.ts";
import { keypairFromEnv } from "./keys.ts";
import { X402_NETWORK } from "./x402Scheme.ts";

const HORIZON = "https://horizon-testnet.stellar.org";

/** Priced in base units of the tab's token (7 decimals). */
export const ROUTES: Record<string, { price: string; description: string; body: () => string }> = {
  "/haiku": {
    price: "1000",
    description: "A haiku about a ledger (0.0001 TAB)",
    body: () => "Seven decimals /\nclose every five seconds -- /\nthe tab remembers",
  },
  "/forecast": {
    price: "2500",
    description: "Tomorrow's Testnet forecast (0.00025 TAB)",
    body: () => JSON.stringify({ at: new Date().toISOString(), ledgerCloseSeconds: 5, outlook: "settled, with a chance of refunds" }),
  },
  "/dataset": {
    price: "20000",
    description: "A dataset priced above a small tab (0.002 TAB)",
    body: () => JSON.stringify({ rows: Array.from({ length: 5 }, (_, i) => ({ i, value: i * i })) }),
  },
};

async function ensureTrustline(secretEnv: string, deployer: string, passphrase: string): Promise<string> {
  const seller = keypairFromEnv(secretEnv);
  const horizon = new Horizon.Server(HORIZON);
  const tab = new Asset("TAB", deployer);

  const account = await horizon.loadAccount(seller.publicKey()).catch(() => {
    throw new Error(
      `seller account ${seller.publicKey()} does not exist on Testnet; ` +
        `run: stellar keys generate barkeep-testnet-seller --network testnet --fund`
    );
  });

  const trusts = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === "TAB" && "asset_issuer" in b && b.asset_issuer === deployer
  );
  if (trusts) return seller.publicKey();

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
    .addOperation(Operation.changeTrust({ asset: tab }))
    .setTimeout(60)
    .build();
  tx.sign(seller);
  const res = await horizon.submitTransaction(tx);
  console.log(`added TAB trustline for ${seller.publicKey()}: ${res.hash}`);
  return seller.publicKey();
}

export async function startSeller(): Promise<void> {
  const deployment = loadDeployment();
  const token = deployment.contracts.token.id;
  const facilitatorUrl = process.env.BARKEEP_FACILITATOR_URL ?? "http://127.0.0.1:4020";
  const port = Number(process.env.BARKEEP_SELLER_PORT ?? 4021);

  const payTo = await ensureTrustline("BARKEEP_SELLER_SECRET", deployment.deployer, deployment.networkPassphrase);

  // Settlement polls the ledger; give it longer than the client's 30 s default.
  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl, timeoutMs: 120_000 });
  const supported = await facilitator.getSupported().catch((e: Error) => {
    throw new Error(`facilitator at ${facilitatorUrl} is not answering /supported: ${e.message}`);
  });
  if (!supported.kinds.some((k) => k.scheme === "exact" && k.network === X402_NETWORK)) {
    throw new Error(`facilitator at ${facilitatorUrl} does not support exact on ${X402_NETWORK}`);
  }

  const log = (...parts: unknown[]) => console.log(new Date().toISOString(), ...parts);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ payTo, token, facilitator: facilitatorUrl, routes: Object.fromEntries(Object.entries(ROUTES).map(([p, r]) => [p, { price: r.price, description: r.description }])) }, null, 2));
      return;
    }

    const route = ROUTES[path];
    if (!route) {
      res.writeHead(404).end();
      return;
    }

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: X402_NETWORK,
      asset: token,
      amount: route.price,
      payTo,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    };

    const signature = req.headers["payment-signature"];
    if (typeof signature !== "string") {
      const required = {
        x402Version: 2,
        resource: { url: `http://${req.headers.host}${path}`, description: route.description, mimeType: "text/plain" },
        accepts: [requirements],
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) }).end("{}");
      log(path, "402 challenge", route.price);
      return;
    }

    const payload = decodePaymentSignatureHeader(signature);

    const verify = await facilitator.verify(payload, requirements);
    if (!verify.isValid) {
      log(path, "verify refused", verify.invalidReason, verify.invalidMessage ?? "");
      res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: verify.invalidReason }));
      return;
    }

    const settle = await facilitator.settle(payload, requirements);
    if (!settle.success) {
      log(path, "settle failed", settle.errorReason, settle.transaction || "");
      res.writeHead(402, { "content-type": "application/json" }).end(JSON.stringify({ error: settle.errorReason }));
      return;
    }

    log(path, "paid", route.price, "by", settle.payer, "tx", settle.transaction);
    res.writeHead(200, { "content-type": "text/plain", "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) });
    res.end(route.body());
  };

  createServer((req, res) => {
    // One failed request must not take the seller down between takes.
    handle(req, res).catch((error: Error) => {
      log(req.url, "error", error.message);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "seller_error", message: error.message }));
    });
  }).listen(port, "127.0.0.1", () => {
    log(`barkeep seller on http://127.0.0.1:${port}  payTo ${payTo}  facilitator ${facilitatorUrl}`);
    for (const [p, r] of Object.entries(ROUTES)) log(`  ${p}  ${r.price}  ${r.description}`);
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  await startSeller();
}
