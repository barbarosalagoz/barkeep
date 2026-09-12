/*
 * Live integration tests against the TR Mock Anchor on Stellar Testnet.
 *
 * Each run creates a throwaway Testnet keypair, funds it with Friendbot and
 * drives the full portable SEP path: SEP-1 discovery, SEP-10 auth, SEP-38
 * quote, SEP-6 deposit (bank leg simulated by the sandbox) with trustline
 * creation, and SEP-6 withdrawal paid with a memo. Real testnet USDC moves.
 *
 * Skip with SEP_SKIP_LIVE=1 (e.g. offline). Run only these with
 *   npx vitest run anchor.live
 */

import { Keypair } from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ANCHOR_ASSET_CODE,
  ANCHOR_FIAT_CODE,
  ANCHOR_HOME_DOMAIN,
  FRIENDBOT_URL,
  NETWORK_PASSPHRASE,
  readEnv,
} from "../../config/stellar";

import {
  AnchorError,
  authenticate,
  beginDeposit,
  connectAnchor,
  discoverAnchor,
  ensureTrustline,
  fiatAssetId,
  forgetAnchorSessions,
  getAssetHolding,
  getInfo,
  getPrice,
  getQuote,
  getTransaction,
  keypairSigner,
  listTransactions,
  quoteDeposit,
  quoteWithdraw,
  runWithdraw,
  simulateBankTransfer,
  startDeposit,
  startWithdraw,
  stellarAssetId,
  watchDeposit,
} from "./index";
import type { AnchorConfig, AuthSession, Sep6Status } from "./index";

const skipLive = readEnv("SEP_SKIP_LIVE") === "1";

const DEPOSIT_TRY = "100.00";
const WITHDRAW_USDC = "1";

const describeLive = skipLive ? describe.skip : describe;

describeLive(`SEP path against ${ANCHOR_HOME_DOMAIN}`, () => {
  const user = Keypair.random();
  const sign = keypairSigner(user, NETWORK_PASSPHRASE);

  let anchor: AnchorConfig;
  let session: AuthSession;

  beforeAll(async () => {
    if (!FRIENDBOT_URL) {
      throw new Error("Live tests need Testnet (Friendbot).");
    }

    const funded = await fetch(`${FRIENDBOT_URL}?addr=${user.publicKey()}`);

    expect(funded.ok).toBe(true);
  });

  afterAll(() => {
    forgetAnchorSessions();
  });

  it("SEP-1: discovers endpoints and the asset issuer from the home domain", async () => {
    anchor = await discoverAnchor({ force: true });

    expect(anchor.homeDomain).toBe(ANCHOR_HOME_DOMAIN);
    expect(anchor.networkPassphrase).toBe(NETWORK_PASSPHRASE);
    expect(anchor.webAuthEndpoint).toMatch(/^https:\/\//);
    expect(anchor.transferServer).toMatch(/^https:\/\//);
    expect(anchor.quoteServer).toMatch(/^https:\/\//);
    expect(anchor.asset.code).toBe(ANCHOR_ASSET_CODE);
    expect(anchor.asset.issuer).toMatch(/^G[A-Z2-7]{55}$/);
    expect(anchor.signingKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(anchor.accounts.length).toBeGreaterThan(0);
  });

  it("SEP-6 /info: deposit and withdraw are enabled for the asset", async () => {
    const info = await getInfo(anchor);

    expect(info.deposit[anchor.asset.code]?.enabled).toBe(true);
    expect(info.withdraw[anchor.asset.code]?.enabled).toBe(true);
  });

  it("SEP-10: verifies the challenge, signs it and gets a JWT", async () => {
    session = await authenticate(anchor, user.publicKey(), sign);

    expect(session.token.split(".")).toHaveLength(3);
    expect(session.account).toBe(user.publicKey());
    expect(session.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it("SEP-10: refuses to sign a challenge from an unknown server key", async () => {
    const wrongKey = Keypair.random().publicKey();

    await expect(
      authenticate({ ...anchor, signingKey: wrongKey }, user.publicKey(), sign)
    ).rejects.toMatchObject({ code: "CHALLENGE_INVALID" });
  });

  it("SEP-10: the anchor rejects a challenge signed by the wrong key", async () => {
    const impostor = keypairSigner(Keypair.random(), NETWORK_PASSPHRASE);

    await expect(
      authenticate(anchor, user.publicKey(), impostor)
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("SEP-6: rejects calls without a token", async () => {
    await expect(
      startDeposit(anchor, "not-a-token", { amount: DEPOSIT_TRY })
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("SEP-38: indicative price and firm quote agree on the pair", async () => {
    const price = await getPrice(anchor, {
      sellAsset: fiatAssetId(anchor.fiatCode),
      buyAsset: stellarAssetId(anchor.asset),
      sellAmount: DEPOSIT_TRY,
    });

    expect(Number(price.price)).toBeGreaterThan(0);
    expect(Number(price.buyAmount)).toBeGreaterThan(0);

    const quote = await quoteDeposit(anchor, session.token, DEPOSIT_TRY);

    expect(quote.sellAsset).toBe(fiatAssetId(ANCHOR_FIAT_CODE));
    expect(quote.buyAsset).toBe(stellarAssetId(anchor.asset));
    expect(quote.sellAmount).toBe(DEPOSIT_TRY);
    expect(Number(quote.buyAmount)).toBeGreaterThan(0);
    expect(Date.parse(quote.expiresAt)).toBeGreaterThan(Date.now());

    const fetched = await getQuote(anchor, session.token, quote.id);

    expect(fetched.id).toBe(quote.id);
    expect(fetched.buyAmount).toBe(quote.buyAmount);
  });

  it("SEP-38: unknown quote ids are NOT_FOUND", async () => {
    await expect(
      getQuote(anchor, session.token, "qt_does_not_exist")
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("SEP-6 deposit: below-minimum amounts are rejected with the anchor's message", async () => {
    await expect(
      startDeposit(anchor, session.token, { amount: "1" })
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AnchorError &&
        error.code === "ANCHOR_REJECTED" &&
        /minimum/i.test(error.message)
    );
  });

  it("SEP-6 deposit: returns IBAN + reference, then credits USDC after the bank leg", async () => {
    const before = await getAssetHolding(user.publicKey(), anchor.asset);

    expect(before.funded).toBe(true);
    expect(before.hasTrustline).toBe(false);

    const quote = await quoteDeposit(anchor, session.token, DEPOSIT_TRY);
    const phases: string[] = [];

    const started = await beginDeposit({
      account: user.publicKey(),
      sign,
      amount: DEPOSIT_TRY,
      quoteId: quote.id,
      onPhase: (phase) => phases.push(phase),
    });

    expect(phases).toEqual([
      "discovering",
      "authenticating",
      "trustline",
      "starting",
      "awaiting_bank",
    ]);

    // The trustline was missing, so beginDeposit created it.
    expect(started.trustline.created).toBe(true);
    expect(started.trustline.hash).toMatch(/^[0-9a-f]{64}$/);

    const { instructions } = started;

    expect(instructions.id).toBeTruthy();
    expect(instructions.iban).toMatch(/^TR\d{24}$/);
    expect(instructions.reference).toMatch(/^[A-Z0-9-]+$/);
    expect(instructions.bankName).toBeTruthy();

    const pending = await getTransaction(anchor, session.token, {
      id: instructions.id,
    });

    expect(pending.kind).toMatch(/^deposit/);
    expect(pending.status).toBe("pending_user_transfer_start");
    expect(pending.externalTransactionId).toBe(instructions.reference);

    // Play the bank (sandbox only).
    await simulateBankTransfer(anchor, instructions.id, DEPOSIT_TRY);

    const seen: Sep6Status[] = [];

    const completed = await watchDeposit(started, instructions.id, {
      account: user.publicKey(),
      sign,
      intervalMs: 2_000,
      timeoutMs: 120_000,
      onUpdate: (transaction) => seen.push(transaction.status),
    });

    expect(completed.status).toBe("completed");
    expect(completed.stellarTransactionId).toMatch(/^[0-9a-f]{64}$/);
    expect(completed.amountInAsset).toBe(fiatAssetId(ANCHOR_FIAT_CODE));
    expect(completed.amountOutAsset).toBe(stellarAssetId(anchor.asset));
    expect(completed.amountOut).toBe(quote.buyAmount);
    expect(seen).toContain("completed");

    const after = await getAssetHolding(user.publicKey(), anchor.asset);

    expect(after.hasTrustline).toBe(true);
    expect(Number(after.balance)).toBeCloseTo(Number(quote.buyAmount), 6);

    // Lookup by Stellar hash resolves to the same anchor transaction.
    const byHash = await getTransaction(anchor, session.token, {
      stellarTransactionId: completed.stellarTransactionId!,
    });

    expect(byHash.id).toBe(instructions.id);
  });

  it("Horizon: ensureTrustline is idempotent once the line exists", async () => {
    const result = await ensureTrustline(user.publicKey(), anchor.asset, sign);

    expect(result.created).toBe(false);
  });

  it("SEP-6 withdraw: below-minimum amounts are rejected", async () => {
    await expect(
      startWithdraw(anchor, session.token, { amount: "0.1" })
    ).rejects.toMatchObject({ code: "ANCHOR_REJECTED" });
  });

  it("SEP-6 withdraw: pays USDC with the anchor's memo and completes the TRY payout", async () => {
    const quote = await quoteWithdraw(anchor, session.token, WITHDRAW_USDC);

    expect(quote.sellAsset).toBe(stellarAssetId(anchor.asset));
    expect(quote.buyAsset).toBe(fiatAssetId(ANCHOR_FIAT_CODE));

    const before = await getAssetHolding(user.publicKey(), anchor.asset);
    const phases: string[] = [];
    let paymentHash: string | undefined;

    const result = await runWithdraw({
      account: user.publicKey(),
      sign,
      amount: WITHDRAW_USDC,
      quoteId: quote.id,
      onPhase: (phase) => phases.push(phase),
      onPayment: (hash) => {
        paymentHash = hash;
      },
      poll: { intervalMs: 2_000, timeoutMs: 120_000 },
    });

    expect(phases).toEqual([
      "discovering",
      "authenticating",
      "starting",
      "paying",
      "polling",
    ]);

    expect(result.instructions.anchorAccount).toMatch(/^G[A-Z2-7]{55}$/);
    expect(anchor.accounts).toContain(result.instructions.anchorAccount);
    expect(result.instructions.memoType).toBe("id");
    expect(result.instructions.memo).toMatch(/^\d+$/);

    expect(result.paymentHash).toBe(paymentHash);
    expect(result.transaction.status).toBe("completed");
    expect(result.transaction.kind).toMatch(/^withdrawal/);
    expect(result.transaction.stellarTransactionId).toBe(result.paymentHash);
    expect(result.transaction.withdrawMemo).toBe(result.instructions.memo);
    expect(result.transaction.amountOutAsset).toBe(fiatAssetId(ANCHOR_FIAT_CODE));
    expect(Number(result.transaction.amountOut)).toBeGreaterThan(0);
    expect(result.transaction.externalTransactionId).toBeTruthy();

    const after = await getAssetHolding(user.publicKey(), anchor.asset);

    expect(Number(before.balance) - Number(after.balance)).toBeCloseTo(
      Number(WITHDRAW_USDC),
      6
    );
  });

  it("SEP-6 withdraw: refuses to start with an insufficient USDC balance", async () => {
    await expect(
      runWithdraw({ account: user.publicKey(), sign, amount: "1000" })
    ).rejects.toMatchObject({ kind: "INSUFFICIENT_BALANCE" });
  });

  it("SEP-6 /transactions: lists both ramps for the account", async () => {
    const history = await listTransactions(anchor, session.token, { limit: 10 });
    const kinds = history.map((transaction) => transaction.kind.split("-")[0]);

    expect(kinds).toContain("deposit");
    expect(kinds).toContain("withdrawal");
    expect(history.every((transaction) => transaction.status === "completed")).toBe(true);
  });

  it("connectAnchor reuses the cached session for the same account", async () => {
    const first = await connectAnchor(user.publicKey(), sign);
    const second = await connectAnchor(user.publicKey(), sign);

    expect(second.session.token).toBe(first.session.token);

    const fresh = await connectAnchor(user.publicKey(), sign, {
      reauthenticate: true,
    });

    expect(fresh.session.token).not.toBe(first.session.token);
  });
});
