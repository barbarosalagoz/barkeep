/*
 * TRY on/off-ramp demo over the portable SEP path.
 *
 * Creates (or reuses) a Testnet key and walks the whole flow against the
 * anchor configured in src/config/stellar.ts:
 *
 *   SEP-1  discover endpoints from the home domain
 *   SEP-10 sign the challenge -> JWT
 *   SEP-38 firm quote for the deposit
 *   SEP-6  deposit: IBAN + reference, simulate the bank leg (sandbox), poll,
 *          USDC lands (trustline created on the way)
 *   SEP-38 firm quote for the withdrawal
 *   SEP-6  withdraw: pay USDC to the anchor with its memo, poll to completed
 *
 * Usage:
 *   npm run demo:sep                      # fresh Friendbot-funded key
 *   SEP_DEMO_SECRET=S... npm run demo:sep # reuse a Testnet key
 *   SEP_DEMO_TRY=250 SEP_DEMO_USDC=2 npm run demo:sep
 *
 * Override the anchor / network with the same VITE_* vars the app uses.
 */

import { Keypair } from "@stellar/stellar-sdk";

import {
  ANCHOR_HOME_DOMAIN,
  ANCHOR_SANDBOX,
  FRIENDBOT_URL,
  NETWORK_LABEL,
  NETWORK_PASSPHRASE,
  explorerTxUrl,
  readEnv,
} from "../src/config/stellar";

import {
  STATUS_LABELS,
  beginDeposit,
  connectAnchor,
  discoverAnchor,
  getAssetHolding,
  keypairSigner,
  listTransactions,
  quoteDeposit,
  quoteWithdraw,
  runWithdraw,
  simulateBankTransfer,
  watchDeposit,
} from "../src/services/anchor";
import type { Sep6Transaction } from "../src/services/anchor";

const DEPOSIT_TRY = readEnv("SEP_DEMO_TRY") ?? "200.00";
const WITHDRAW_USDC = readEnv("SEP_DEMO_USDC") ?? "1";

const startedAt = Date.now();

const log = (message: string): void => {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1).padStart(6);
  console.log(`[${elapsed}s] ${message}`);
};

let lastStatus: string | undefined;

const traceStatus = (transaction: Sep6Transaction): void => {
  if (transaction.status !== lastStatus) {
    lastStatus = transaction.status;
    log(
      `      status: ${transaction.status} (${STATUS_LABELS[transaction.status] ?? "?"})${
        transaction.message ? ` - ${transaction.message}` : ""
      }`
    );
  }
};

async function main(): Promise<void> {
  const secret = readEnv("SEP_DEMO_SECRET");
  const user = secret ? Keypair.fromSecret(secret) : Keypair.random();
  const sign = keypairSigner(user, NETWORK_PASSPHRASE);

  log(`network: ${NETWORK_LABEL}`);
  log(`anchor home domain: ${ANCHOR_HOME_DOMAIN}`);
  log(`user account: ${user.publicKey()}${secret ? "" : " (fresh)"}`);

  if (!secret) {
    if (!FRIENDBOT_URL) {
      throw new Error("No SEP_DEMO_SECRET and no Friendbot on this network.");
    }

    const funded = await fetch(`${FRIENDBOT_URL}?addr=${user.publicKey()}`);

    if (!funded.ok) {
      throw new Error(`Friendbot failed: HTTP ${funded.status}`);
    }

    log("funded with Friendbot");
  }

  /* SEP-1 */
  const anchor = await discoverAnchor();

  log(`SEP-1  ${anchor.orgName ?? anchor.homeDomain}`);
  log(`       auth     ${anchor.webAuthEndpoint}`);
  log(`       transfer ${anchor.transferServer}`);
  log(`       quotes   ${anchor.quoteServer ?? "-"}`);
  log(`       asset    ${anchor.asset.code}:${anchor.asset.issuer}`);

  /* Deposit */
  const { session } = await connectAnchor(user.publicKey(), sign);

  log("SEP-10 logged in (JWT)");

  const depositQuote = await quoteDeposit(anchor, session.token, DEPOSIT_TRY);

  log(
    `SEP-38 quote ${depositQuote.id}: ${depositQuote.sellAmount} ${anchor.fiatCode} -> ${depositQuote.buyAmount} ${anchor.asset.code} @ ${depositQuote.totalPrice ?? depositQuote.price} (fee ${depositQuote.fee?.total ?? "0"} ${anchor.fiatCode}, valid until ${depositQuote.expiresAt})`
  );

  const started = await beginDeposit({
    account: user.publicKey(),
    sign,
    amount: DEPOSIT_TRY,
    quoteId: depositQuote.id,
    onPhase: (phase) => log(`SEP-6  deposit phase: ${phase}`),
  });

  if (started.trustline.created) {
    log(`       trustline added: ${explorerTxUrl(started.trustline.hash!)}`);
  }

  const { instructions } = started;

  log(`SEP-6  deposit ${instructions.id} opened`);
  log(`       bank      ${instructions.bankName ?? "-"}`);
  log(`       IBAN      ${instructions.iban ?? "-"}`);
  log(`       reference ${instructions.reference ?? "-"}`);

  if (ANCHOR_SANDBOX) {
    await simulateBankTransfer(anchor, instructions.id, DEPOSIT_TRY);
    log("       sandbox: simulated the incoming bank transfer");
  } else {
    log("       waiting for the real bank transfer to arrive...");
  }

  const deposit = await watchDeposit(started, instructions.id, {
    account: user.publicKey(),
    sign,
    intervalMs: 2_000,
    timeoutMs: ANCHOR_SANDBOX ? 180_000 : 30 * 60_000,
    onUpdate: traceStatus,
  });

  log(
    `       deposit completed: ${deposit.amountIn} ${anchor.fiatCode} -> ${deposit.amountOut} ${anchor.asset.code}`
  );
  log(`       stellar tx ${explorerTxUrl(deposit.stellarTransactionId ?? "")}`);

  const afterDeposit = await getAssetHolding(user.publicKey(), anchor.asset);

  log(`       ${anchor.asset.code} balance now ${afterDeposit.balance}`);

  /* Withdraw */
  const withdrawQuote = await quoteWithdraw(anchor, session.token, WITHDRAW_USDC);

  log(
    `SEP-38 quote ${withdrawQuote.id}: ${withdrawQuote.sellAmount} ${anchor.asset.code} -> ${withdrawQuote.buyAmount} ${anchor.fiatCode}`
  );

  lastStatus = undefined;

  const withdrawal = await runWithdraw({
    account: user.publicKey(),
    sign,
    amount: WITHDRAW_USDC,
    quoteId: withdrawQuote.id,
    onPhase: (phase) => log(`SEP-6  withdraw phase: ${phase}`),
    onPayment: (hash) => log(`       paid ${WITHDRAW_USDC} ${anchor.asset.code} with memo: ${explorerTxUrl(hash)}`),
    poll: { intervalMs: 2_000, timeoutMs: 180_000, onUpdate: traceStatus },
  });

  log(
    `       withdrawal completed: ${withdrawal.transaction.amountIn} ${anchor.asset.code} -> ${withdrawal.transaction.amountOut} ${anchor.fiatCode} (bank ref ${withdrawal.transaction.externalTransactionId ?? "-"})`
  );

  const afterWithdraw = await getAssetHolding(user.publicKey(), anchor.asset);

  log(`       ${anchor.asset.code} balance now ${afterWithdraw.balance}`);

  /* History */
  const history = await listTransactions(anchor, session.token, { limit: 5 });

  log(`SEP-6  history (${history.length}):`);

  for (const transaction of history) {
    log(
      `       ${transaction.kind.padEnd(19)} ${transaction.status.padEnd(10)} ${transaction.amountIn ?? "?"} -> ${transaction.amountOut ?? "?"}`
    );
  }

  log("done");
}

main().catch((error: unknown) => {
  const detail =
    error && typeof error === "object" && "code" in error
      ? ` [${String((error as { code: unknown }).code)}]`
      : "";

  console.error(`\nFAILED${detail}: ${error instanceof Error ? error.message : String(error)}`);

  if (error && typeof error === "object" && "hint" in error && (error as { hint?: string }).hint) {
    console.error(`hint: ${(error as { hint: string }).hint}`);
  }

  process.exitCode = 1;
});
