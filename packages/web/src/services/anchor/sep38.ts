/*
 * SEP-38: indicative prices and firm quotes.
 *
 * Assets use SEP-38 identifiers: "iso4217:TRY" for the fiat leg and
 * "stellar:USDC:<issuer>" for the on-chain leg. A firm quote's id is then
 * passed to SEP-6 deposit-exchange / withdraw-exchange to lock the rate.
 */

import { AnchorError } from "./errors";
import { anchorFetch, joinUrl } from "./http";
import type { AnchorAsset, AnchorConfig } from "./sep1";

export const fiatAssetId = (code: string): string => `iso4217:${code}`;

export const stellarAssetId = (asset: AnchorAsset): string =>
  `stellar:${asset.code}:${asset.issuer}`;

/** "iso4217:TRY" -> "TRY", "stellar:USDC:G..." -> "USDC". */
export function assetCodeOf(assetId: string): string {
  const parts = assetId.split(":");

  return parts.length >= 2 ? parts[1] : assetId;
}

export interface FeeDetail {
  name: string;
  description?: string;
  amount: string;
}

export interface QuoteFee {
  total: string;
  asset: string;
  details?: FeeDetail[];
}

export interface Price {
  /** Price of one unit of buy_asset in sell_asset, excluding fees. */
  price: string;
  /** Price including fees (SEP-38 total_price). */
  totalPrice?: string;
  sellAmount: string;
  buyAmount: string;
  fee?: QuoteFee;
}

export interface Quote extends Price {
  id: string;
  sellAsset: string;
  buyAsset: string;
  /** ISO 8601. */
  expiresAt: string;
}

export interface PriceRequest {
  sellAsset: string;
  buyAsset: string;
  sellAmount?: string;
  buyAmount?: string;
  sellDeliveryMethod?: string;
  buyDeliveryMethod?: string;
  countryCode?: string;
  context?: "sep6" | "sep31";
}

export interface QuoteRequest extends PriceRequest {
  /** ISO 8601 timestamp the quote should stay valid until (anchor may shorten it). */
  expireAfter?: string;
}

interface RawFee {
  total?: unknown;
  asset?: unknown;
  details?: unknown;
}

interface RawPrice {
  price?: unknown;
  total_price?: unknown;
  sell_amount?: unknown;
  buy_amount?: unknown;
  fee?: RawFee;
}

interface RawQuote extends RawPrice {
  id?: unknown;
  sell_asset?: unknown;
  buy_asset?: unknown;
  expires_at?: unknown;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);

function parseFee(raw: RawFee | undefined): QuoteFee | undefined {
  if (!raw || raw.total === undefined) {
    return undefined;
  }

  const details = Array.isArray(raw.details)
    ? (raw.details as Record<string, unknown>[]).map((detail) => ({
        name: str(detail.name),
        description:
          typeof detail.description === "string" ? detail.description : undefined,
        amount: str(detail.amount),
      }))
    : undefined;

  return { total: str(raw.total), asset: str(raw.asset), details };
}

export function parsePrice(raw: RawPrice): Price {
  return {
    price: str(raw.price),
    totalPrice: raw.total_price === undefined ? undefined : str(raw.total_price),
    sellAmount: str(raw.sell_amount),
    buyAmount: str(raw.buy_amount),
    fee: parseFee(raw.fee),
  };
}

export function parseQuote(raw: RawQuote): Quote {
  if (typeof raw.id !== "string" || !raw.id) {
    throw new AnchorError("ANCHOR_REJECTED", "The anchor returned a quote without an id.");
  }

  return {
    ...parsePrice(raw),
    id: raw.id,
    sellAsset: str(raw.sell_asset),
    buyAsset: str(raw.buy_asset),
    expiresAt: str(raw.expires_at),
  };
}

function requireQuoteServer(anchor: AnchorConfig): string {
  if (!anchor.quoteServer) {
    throw new AnchorError(
      "TOML_INVALID",
      `${anchor.homeDomain} does not advertise ANCHOR_QUOTE_SERVER (SEP-38).`
    );
  }

  return anchor.quoteServer;
}

function toQuery(request: PriceRequest) {
  return {
    sell_asset: request.sellAsset,
    buy_asset: request.buyAsset,
    sell_amount: request.sellAmount,
    buy_amount: request.buyAmount,
    sell_delivery_method: request.sellDeliveryMethod,
    buy_delivery_method: request.buyDeliveryMethod,
    country_code: request.countryCode,
    context: request.context ?? "sep6",
  };
}

/** Indicative price for a pair (GET /price). Auth is optional per spec. */
export function getPrice(
  anchor: AnchorConfig,
  request: PriceRequest,
  token?: string
): Promise<Price> {
  if (!request.sellAmount && !request.buyAmount) {
    throw new AnchorError("ANCHOR_REJECTED", "A price needs sell_amount or buy_amount.");
  }

  return anchorFetch<RawPrice>(joinUrl(requireQuoteServer(anchor), "price"), {
    query: toQuery(request),
    token,
  }).then(parsePrice);
}

/** Firm quote (POST /quote). The returned id locks the rate for SEP-6. */
export function requestQuote(
  anchor: AnchorConfig,
  token: string,
  request: QuoteRequest
): Promise<Quote> {
  if (!request.sellAmount && !request.buyAmount) {
    throw new AnchorError("ANCHOR_REJECTED", "A quote needs sell_amount or buy_amount.");
  }

  const body: Record<string, string | undefined> = {
    ...toQuery(request),
    expire_after: request.expireAfter,
  };

  return anchorFetch<RawQuote>(joinUrl(requireQuoteServer(anchor), "quote"), {
    method: "POST",
    body,
    token,
  }).then(parseQuote);
}

/** Fetch a quote by id (GET /quote/:id). */
export function getQuote(
  anchor: AnchorConfig,
  token: string,
  id: string
): Promise<Quote> {
  return anchorFetch<RawQuote>(
    joinUrl(requireQuoteServer(anchor), `quote/${encodeURIComponent(id)}`),
    { token }
  ).then(parseQuote);
}

/** Firm quote for a deposit: sell `fiatAmount` of fiat, buy the anchor asset. */
export function quoteDeposit(
  anchor: AnchorConfig,
  token: string,
  fiatAmount: string
): Promise<Quote> {
  return requestQuote(anchor, token, {
    sellAsset: fiatAssetId(anchor.fiatCode),
    buyAsset: stellarAssetId(anchor.asset),
    sellAmount: fiatAmount,
    context: "sep6",
  });
}

/** Firm quote for a withdrawal: sell `assetAmount` of the anchor asset, buy fiat. */
export function quoteWithdraw(
  anchor: AnchorConfig,
  token: string,
  assetAmount: string
): Promise<Quote> {
  return requestQuote(anchor, token, {
    sellAsset: stellarAssetId(anchor.asset),
    buyAsset: fiatAssetId(anchor.fiatCode),
    sellAmount: assetAmount,
    context: "sep6",
  });
}

/** Seconds until the quote expires (negative once expired). */
export function quoteSecondsLeft(
  quote: Pick<Quote, "expiresAt">,
  nowMs: number = Date.now()
): number {
  const expires = Date.parse(quote.expiresAt);

  return Number.isNaN(expires) ? Infinity : Math.floor((expires - nowMs) / 1000);
}
