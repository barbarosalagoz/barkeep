/*
 * Offline unit tests for the SEP client: toml validation, response parsing,
 * error classification, memo building. No network.
 */

import { Keypair, Memo, Networks, WebAuth } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";


import { AnchorError } from "./errors";
import { buildMemo, normalizeAmount } from "./horizon";
import { classifyStatus, joinUrl, withQuery } from "./http";
import { parseAnchorToml } from "./sep1";
import { decodeJwtPayload, isSessionValid } from "./sep10";
import { assetCodeOf, fiatAssetId, parseQuote, quoteSecondsLeft, stellarAssetId } from "./sep38";
import {
  isTerminalStatus,
  parseDepositResponse,
  parseInfo,
  parseTransaction,
  parseWithdrawResponse,
} from "./sep6";

const SIGNING_KEY = Keypair.random().publicKey();

const base64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const bytesToBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));
const ISSUER = Keypair.random().publicKey();

const validToml = () => ({
  NETWORK_PASSPHRASE: Networks.TESTNET,
  SIGNING_KEY,
  WEB_AUTH_ENDPOINT: "https://anchor.example/auth",
  TRANSFER_SERVER: "https://anchor.example/sep6",
  ANCHOR_QUOTE_SERVER: "https://anchor.example/sep38/",
  KYC_SERVER: "https://anchor.example/sep12",
  ACCOUNTS: [SIGNING_KEY, "not-a-key"],
  DOCUMENTATION: { ORG_NAME: "Example Anchor" },
  CURRENCIES: [{ code: "USDC", issuer: ISSUER, status: "test" }],
});

const tomlOptions = {
  homeDomain: "anchor.example",
  assetCode: "USDC",
  fiatCode: "TRY",
  networkPassphrase: Networks.TESTNET,
};

describe("SEP-1 parseAnchorToml", () => {
  it("extracts endpoints, signing key, issuer and accounts", () => {
    const anchor = parseAnchorToml(validToml(), tomlOptions);

    expect(anchor.signingKey).toBe(SIGNING_KEY);
    expect(anchor.webAuthEndpoint).toBe("https://anchor.example/auth");
    expect(anchor.webAuthDomain).toBe("anchor.example");
    expect(anchor.transferServer).toBe("https://anchor.example/sep6");
    expect(anchor.quoteServer).toBe("https://anchor.example/sep38");
    expect(anchor.kycServer).toBe("https://anchor.example/sep12");
    expect(anchor.asset).toEqual({ code: "USDC", issuer: ISSUER });
    expect(anchor.accounts).toEqual([SIGNING_KEY]);
    expect(anchor.orgName).toBe("Example Anchor");
    expect(anchor.fiatCode).toBe("TRY");
  });

  it("rejects a toml on another network", () => {
    expect(() =>
      parseAnchorToml(
        { ...validToml(), NETWORK_PASSPHRASE: Networks.PUBLIC },
        tomlOptions
      )
    ).toThrow(expect.objectContaining({ code: "NETWORK_MISMATCH" }));
  });

  it("rejects a toml without SIGNING_KEY, WEB_AUTH_ENDPOINT or TRANSFER_SERVER", () => {
    for (const key of ["SIGNING_KEY", "WEB_AUTH_ENDPOINT", "TRANSFER_SERVER"]) {
      const doc = validToml() as Record<string, unknown>;
      delete doc[key];

      expect(() => parseAnchorToml(doc, tomlOptions)).toThrow(
        expect.objectContaining({ code: "TOML_INVALID" })
      );
    }
  });

  it("rejects http endpoints", () => {
    expect(() =>
      parseAnchorToml(
        { ...validToml(), TRANSFER_SERVER: "http://anchor.example/sep6" },
        tomlOptions
      )
    ).toThrow(expect.objectContaining({ code: "TOML_INVALID" }));
  });

  it("rejects an unlisted asset", () => {
    expect(() =>
      parseAnchorToml(validToml(), { ...tomlOptions, assetCode: "EURC" })
    ).toThrow(expect.objectContaining({ code: "ASSET_NOT_LISTED" }));
  });

  it("leaves the quote server undefined when the anchor has none", () => {
    const doc = validToml() as Record<string, unknown>;
    delete doc.ANCHOR_QUOTE_SERVER;

    expect(parseAnchorToml(doc, tomlOptions).quoteServer).toBeUndefined();
  });
});

describe("SEP-10 helpers", () => {
  it("decodes a JWT payload and judges validity", () => {
    const payload = { sub: "G...", iat: 1_700_000_000, exp: 1_700_086_400 };
    const encoded = base64url(JSON.stringify(payload));
    const token = `eyJhbGciOiJIUzI1NiJ9.${encoded}.sig`;

    expect(decodeJwtPayload(token)).toEqual(payload);
    expect(decodeJwtPayload("garbage")).toBeNull();

    const session = {
      token,
      account: "G...",
      homeDomain: "anchor.example",
      expiresAt: payload.exp,
    };

    expect(isSessionValid(session, (payload.exp - 3_600) * 1000)).toBe(true);
    expect(isSessionValid(session, (payload.exp - 30) * 1000)).toBe(false);
    expect(isSessionValid({ ...session, expiresAt: undefined })).toBe(true);
  });

  it("verifies a well-formed challenge and rejects a tampered one", () => {
    const server = Keypair.random();
    const client = Keypair.random();

    const challenge = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      "anchor.example",
      300,
      Networks.TESTNET,
      "anchor.example"
    );

    const verified = WebAuth.readChallengeTx(
      challenge,
      server.publicKey(),
      Networks.TESTNET,
      "anchor.example",
      "anchor.example"
    );

    expect(verified.clientAccountID).toBe(client.publicKey());

    // Wrong server key: the signature check must fail before we sign.
    expect(() =>
      WebAuth.readChallengeTx(
        challenge,
        Keypair.random().publicKey(),
        Networks.TESTNET,
        "anchor.example",
        "anchor.example"
      )
    ).toThrow();
  });
});

describe("HTTP helpers", () => {
  it("joins URLs and encodes queries, skipping empty values", () => {
    expect(joinUrl("https://a.example/sep6/", "/deposit")).toBe(
      "https://a.example/sep6/deposit"
    );
    expect(
      withQuery("https://a.example/x", {
        asset_code: "USDC",
        amount: undefined,
        memo: "",
        limit: 5,
      })
    ).toBe("https://a.example/x?asset_code=USDC&limit=5");
  });

  it("maps anchor error responses onto codes", () => {
    expect(classifyStatus(403, { type: "authentication_required" }, "")).toBe(
      "AUTH_REQUIRED"
    );
    expect(
      classifyStatus(403, { type: "non_interactive_customer_info_needed" }, "")
    ).toBe("KYC_REQUIRED");
    expect(classifyStatus(404, { error: "transaction not found" }, "")).toBe(
      "NOT_FOUND"
    );
    expect(classifyStatus(422, null, "quote expired")).toBe("QUOTE_EXPIRED");
    expect(classifyStatus(400, { error: "amount below minimum" }, "x")).toBe(
      "ANCHOR_REJECTED"
    );
  });

  it("keeps AnchorError inside the AppError taxonomy", () => {
    const error = new AnchorError("NOT_FOUND", "quote not found", { status: 404 });

    expect(error.kind).toBe("ANCHOR");
    expect(error.status).toBe(404);
    expect(error).toBeInstanceOf(Error);
  });
});

describe("SEP-38 parsing", () => {
  it("builds asset identifiers", () => {
    expect(fiatAssetId("TRY")).toBe("iso4217:TRY");
    expect(stellarAssetId({ code: "USDC", issuer: ISSUER })).toBe(
      `stellar:USDC:${ISSUER}`
    );
    expect(assetCodeOf("iso4217:TRY")).toBe("TRY");
    expect(assetCodeOf(`stellar:USDC:${ISSUER}`)).toBe("USDC");
  });

  it("parses a firm quote", () => {
    const quote = parseQuote({
      id: "qt_1",
      expires_at: "2030-01-01T00:00:00Z",
      total_price: "48.70",
      price: "48.46",
      sell_asset: "iso4217:TRY",
      sell_amount: "100.00",
      buy_asset: `stellar:USDC:${ISSUER}`,
      buy_amount: "2.0533010",
      fee: { total: "0.50", asset: "iso4217:TRY", details: [{ name: "spread", amount: "0.50" }] },
    });

    expect(quote.id).toBe("qt_1");
    expect(quote.buyAmount).toBe("2.0533010");
    expect(quote.fee?.details?.[0].name).toBe("spread");
    expect(quoteSecondsLeft(quote, Date.parse("2029-12-31T23:59:00Z"))).toBe(60);
    expect(() => parseQuote({ price: "1" })).toThrow(/without an id/);
  });
});

describe("SEP-6 parsing", () => {
  it("parses deposit instructions into IBAN + reference", () => {
    const deposit = parseDepositResponse({
      id: "sep_1",
      how: "Send TRY to IBAN TR05...",
      eta: 5,
      min_amount: 50,
      max_amount: 3000,
      fee_percent: 0.5,
      instructions: {
        bank_name: { value: "TR Mock Bank", description: "Bank" },
        bank_account_number: { value: "TR050009900000000000000001" },
        external_transfer_memo: { value: "TRMA-AAAA-BBBB" },
      },
      extra_info: { message: "sandbox" },
    });

    expect(deposit.iban).toBe("TR050009900000000000000001");
    expect(deposit.reference).toBe("TRMA-AAAA-BBBB");
    expect(deposit.bankName).toBe("TR Mock Bank");
    expect(deposit.minAmount).toBe(50);
    expect(deposit.extraInfo?.message).toBe("sandbox");
    expect(() => parseDepositResponse({ how: "x" })).toThrow(/transaction id/);
  });

  it("parses withdraw instructions, accepting memo or memo_id", () => {
    const withdraw = parseWithdrawResponse({
      account_id: SIGNING_KEY,
      memo_type: "id",
      memo: "123",
      id: "sep_2",
      eta: 10,
    });

    expect(withdraw.anchorAccount).toBe(SIGNING_KEY);
    expect(withdraw.memo).toBe("123");
    expect(withdraw.memoType).toBe("id");

    const legacy = parseWithdrawResponse({
      account_id: SIGNING_KEY,
      memo_id: "456",
      id: "sep_3",
    });

    expect(legacy.memo).toBe("456");
    expect(legacy.memoType).toBe("id");
  });

  it("parses a transaction record", () => {
    const transaction = parseTransaction({
      id: "sep_4",
      kind: "withdrawal",
      status: "completed",
      amount_in: "1.0000000",
      amount_in_asset: `stellar:USDC:${ISSUER}`,
      amount_out: "48.21",
      amount_out_asset: "iso4217:TRY",
      amount_fee: "0.24",
      withdraw_anchor_account: SIGNING_KEY,
      withdraw_memo: "820289595710",
      withdraw_memo_type: "id",
      stellar_transaction_id: "df50",
      external_transaction_id: "FAST-1",
      fee_details: { total: "0.24", asset: "iso4217:TRY" },
    });

    expect(transaction.kind).toBe("withdrawal");
    expect(transaction.withdrawMemoType).toBe("id");
    expect(transaction.feeDetails?.total).toBe("0.24");
    expect(isTerminalStatus(transaction.status)).toBe(true);
    expect(isTerminalStatus("pending_anchor")).toBe(false);
    expect(() => parseTransaction({ id: "x" })).toThrow(/id or status/);
  });

  it("parses /info", () => {
    const info = parseInfo({
      deposit: { USDC: { enabled: true, min_amount: 0.5, max_amount: 300, funding_methods: ["bank_account"] } },
      "deposit-exchange": { USDC: { enabled: true } },
      withdraw: { USDC: { enabled: false } },
      features: { account_creation: false, claimable_balances: true },
    });

    expect(info.deposit.USDC.enabled).toBe(true);
    expect(info.deposit.USDC.fundingMethods).toEqual(["bank_account"]);
    expect(info.depositExchange.USDC.enabled).toBe(true);
    expect(info.withdraw.USDC.enabled).toBe(false);
    expect(info.features.claimableBalances).toBe(true);
  });
});

describe("Horizon helpers", () => {
  it("builds the memo the anchor asked for", () => {
    expect(buildMemo("42", "id").type).toBe("id");
    expect(buildMemo("hello", "text").type).toBe("text");
    expect(buildMemo(undefined).type).toBe("none");

    const hashBytes = new Uint8Array(32).fill(7);
    const memo = buildMemo(bytesToBase64(hashBytes), "hash");

    expect(memo.type).toBe("hash");
    expect(Array.from(memo.value as Uint8Array)).toEqual(Array.from(hashBytes));
    expect(Memo.id("42").value).toBe("42");
  });

  it("normalises amounts to 7 decimals", () => {
    expect(normalizeAmount("1")).toBe("1");
    expect(normalizeAmount("1.5000000")).toBe("1.5");
    expect(normalizeAmount(" 0.0000001 ")).toBe("0.0000001");
    expect(() => normalizeAmount("0")).toThrow(/greater than zero/);
    expect(() => normalizeAmount("1.12345678")).toThrow(/7 decimal/);
    expect(() => normalizeAmount("abc")).toThrow(/decimal amount/);
  });
});
