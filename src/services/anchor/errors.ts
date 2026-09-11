/*
 * Anchor-specific errors.
 *
 * AnchorError extends the app-wide AppError (kind "ANCHOR") so the existing
 * classifyError pipeline passes it through untouched instead of pattern
 * matching an anchor message like "quote not found" onto WALLET_NOT_FOUND.
 */

import { AppError } from "../../errors";

export type AnchorErrorCode =
  /** stellar.toml could not be fetched. */
  | "TOML_UNREACHABLE"
  /** stellar.toml is missing a field the SEP flow needs. */
  | "TOML_INVALID"
  /** The anchor is on a different network than this build. */
  | "NETWORK_MISMATCH"
  /** The configured asset code is not in the anchor's CURRENCIES. */
  | "ASSET_NOT_LISTED"
  /** The SEP-10 challenge failed verification (bad signer, domain, etc.). */
  | "CHALLENGE_INVALID"
  /** The anchor rejected the signed challenge. */
  | "AUTH_FAILED"
  /** A SEP-6/38 call was made without (or with an expired) JWT. */
  | "AUTH_REQUIRED"
  /** The anchor needs SEP-12 KYC before continuing. */
  | "KYC_REQUIRED"
  /** The anchor returned 4xx/5xx with a message. */
  | "ANCHOR_REJECTED"
  /** Transaction / quote not found. */
  | "NOT_FOUND"
  /** The SEP-38 quote expired before it was used. */
  | "QUOTE_EXPIRED"
  /** Polling gave up before a terminal status. */
  | "POLL_TIMEOUT"
  /** Polling was aborted by the caller. */
  | "CANCELLED"
  /** The Stellar account does not exist yet (no XLM). */
  | "ACCOUNT_NOT_FUNDED"
  /** The anchor reported the transaction as failed. */
  | "TRANSACTION_FAILED";

export interface AnchorErrorOptions {
  status?: number;
  hint?: string;
  details?: unknown;
}

export class AnchorError extends AppError {
  readonly code: AnchorErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    code: AnchorErrorCode,
    message: string,
    options: AnchorErrorOptions = {}
  ) {
    super("ANCHOR", message, options.hint);
    this.name = "AnchorError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

export function isAnchorError(
  error: unknown,
  code?: AnchorErrorCode
): error is AnchorError {
  return (
    error instanceof AnchorError && (code === undefined || error.code === code)
  );
}
