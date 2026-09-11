/*
 * SEP-10: log in to the anchor by signing a challenge with the user's key.
 *
 * 1. GET  WEB_AUTH_ENDPOINT?account=G...          -> unsigned challenge XDR
 * 2. Verify the challenge (server signature, home domain, web_auth_domain,
 *    client account) with the SDK's WebAuth helpers BEFORE signing anything.
 * 3. Sign it with the user's key (wallet extension, or a Keypair in tests).
 * 4. POST the signed XDR back                       -> { token: <JWT> }
 *
 * The JWT is the bearer token for every SEP-6 / SEP-38 call.
 */

import { Keypair, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

import { NETWORK_PASSPHRASE } from "../../config/stellar";

import { AnchorError } from "./errors";
import { anchorFetch } from "./http";
import type { AnchorConfig } from "./sep1";

/**
 * Signs a base64 transaction envelope and returns the signed envelope.
 * In the app this is the connected wallet; in tests and the demo it is a
 * Keypair. Also used for trustline and payment transactions.
 */
export type XdrSigner = (transactionXdr: string) => Promise<string>;

/** A signer backed by a raw Keypair (tests, scripts; never in the UI). */
export function keypairSigner(
  keypair: Keypair,
  networkPassphrase: string = NETWORK_PASSPHRASE
): XdrSigner {
  return async (transactionXdr) => {
    const transaction = TransactionBuilder.fromXdr(
      transactionXdr,
      networkPassphrase
    );

    transaction.sign(keypair);

    return transaction.toXdr();
  };
}

export interface AuthSession {
  token: string;
  account: string;
  homeDomain: string;
  /** Unix seconds, from the JWT if present. */
  issuedAt?: number;
  expiresAt?: number;
}

export interface AuthenticateOptions {
  /** SEP-10 memo for shared/custodial accounts. */
  memo?: string;
  /** Override the home domain sent to the server (defaults to the anchor's). */
  homeDomain?: string;
  signal?: AbortSignal;
}

interface ChallengeResponse {
  transaction?: string;
  network_passphrase?: string;
  error?: string;
}

interface TokenResponse {
  token?: string;
  error?: string;
}

/** Decode a JWT payload without verifying it (we only read exp/iat). */
export function decodeJwtPayload(
  token: string
): Record<string, unknown> | null {
  const parts = token.split(".");

  if (parts.length < 2) {
    return null;
  }

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = atob(padded);

    const parsed = JSON.parse(json) as unknown;

    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True while the token has at least `skewSeconds` of life left. */
export function isSessionValid(
  session: AuthSession,
  nowMs: number = Date.now(),
  skewSeconds = 60
): boolean {
  if (session.expiresAt === undefined) {
    return true;
  }

  return session.expiresAt - skewSeconds > nowMs / 1000;
}

/**
 * Run the SEP-10 handshake for `account` and return a bearer session.
 *
 * Throws CHALLENGE_INVALID if the anchor's challenge does not verify (which
 * means we never ask the wallet to sign it), and AUTH_FAILED if the anchor
 * rejects our signature.
 */
export async function authenticate(
  anchor: AnchorConfig,
  account: string,
  sign: XdrSigner,
  options: AuthenticateOptions = {}
): Promise<AuthSession> {
  const homeDomain = options.homeDomain ?? anchor.homeDomain;

  const challenge = await anchorFetch<ChallengeResponse>(
    anchor.webAuthEndpoint,
    {
      query: { account, home_domain: homeDomain, memo: options.memo },
      signal: options.signal,
    }
  );

  if (!challenge.transaction) {
    throw new AnchorError(
      "CHALLENGE_INVALID",
      challenge.error ?? "The anchor returned no challenge transaction."
    );
  }

  if (
    challenge.network_passphrase &&
    challenge.network_passphrase !== anchor.networkPassphrase
  ) {
    throw new AnchorError(
      "NETWORK_MISMATCH",
      `The SEP-10 challenge is for "${challenge.network_passphrase}", not "${anchor.networkPassphrase}".`
    );
  }

  let clientAccountID: string;
  let challengeMemo: string | null | undefined;

  try {
    /*
     * readChallengeTx enforces the SEP-10 rules: sequence 0, valid server
     * signature, first op is "<home_domain> auth" from the client account,
     * web_auth_domain op signed by the server key, sane time bounds.
     */
    const verified = WebAuth.readChallengeTx(
      challenge.transaction,
      anchor.signingKey,
      anchor.networkPassphrase,
      homeDomain,
      anchor.webAuthDomain
    );

    clientAccountID = verified.clientAccountID;
    challengeMemo = verified.memo;
  } catch (error) {
    throw new AnchorError(
      "CHALLENGE_INVALID",
      `Refusing to sign the anchor's SEP-10 challenge: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { details: error }
    );
  }

  if (clientAccountID !== account) {
    throw new AnchorError(
      "CHALLENGE_INVALID",
      `The challenge is addressed to ${clientAccountID}, not the connected account.`
    );
  }

  if (options.memo !== undefined && String(challengeMemo ?? "") !== options.memo) {
    throw new AnchorError(
      "CHALLENGE_INVALID",
      "The challenge memo does not match the requested memo."
    );
  }

  const signedXdr = await sign(challenge.transaction);

  const response = await anchorFetch<TokenResponse>(anchor.webAuthEndpoint, {
    method: "POST",
    body: { transaction: signedXdr },
    signal: options.signal,
  }).catch((error: unknown) => {
    if (error instanceof AnchorError) {
      throw new AnchorError("AUTH_FAILED", error.message, {
        status: error.status,
        details: error.details,
      });
    }

    throw error;
  });

  if (!response.token) {
    throw new AnchorError(
      "AUTH_FAILED",
      response.error ?? "The anchor did not return a token."
    );
  }

  const payload = decodeJwtPayload(response.token);

  return {
    token: response.token,
    account,
    homeDomain,
    issuedAt:
      typeof payload?.iat === "number" ? (payload.iat as number) : undefined,
    expiresAt:
      typeof payload?.exp === "number" ? (payload.exp as number) : undefined,
  };
}
