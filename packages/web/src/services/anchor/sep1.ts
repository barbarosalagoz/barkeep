/*
 * SEP-1: anchor discovery from a home domain.
 *
 * The whole hand-off from an anchor is two values: a home domain and an
 * asset code. Everything else (auth endpoint, transfer server, quote server,
 * signing key, asset issuer) is read from
 * https://<home-domain>/.well-known/stellar.toml and validated here.
 */

import { StellarToml, StrKey } from "@stellar/stellar-sdk";

import {
  ANCHOR_ASSET_CODE,
  ANCHOR_FIAT_CODE,
  ANCHOR_HOME_DOMAIN,
  NETWORK_PASSPHRASE,
} from "../../config/stellar";

import { AnchorError } from "./errors";

export interface AnchorAsset {
  code: string;
  issuer: string;
}

/** Everything the SEP-10/6/38 client needs, as discovered from stellar.toml. */
export interface AnchorConfig {
  homeDomain: string;
  networkPassphrase: string;
  signingKey: string;
  webAuthEndpoint: string;
  /** Host of the auth endpoint, checked against the challenge's web_auth_domain op. */
  webAuthDomain: string;
  transferServer: string;
  quoteServer?: string;
  kycServer?: string;
  accounts: string[];
  asset: AnchorAsset;
  /** ISO 4217 code of the fiat leg (from config, not the toml). */
  fiatCode: string;
  orgName?: string;
}

export interface DiscoverOptions {
  homeDomain?: string;
  assetCode?: string;
  fiatCode?: string;
  /** Passphrase this build runs on; the toml must agree. */
  networkPassphrase?: string;
  /** Bypass the in-memory cache. */
  force?: boolean;
}

type TomlDocument = Record<string, unknown>;

function readString(doc: TomlDocument, key: string): string | undefined {
  const value = doc[key];

  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireHttps(url: string, key: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new AnchorError("TOML_INVALID", `${key} in stellar.toml is not a URL.`);
  }

  if (parsed.protocol !== "https:") {
    throw new AnchorError(
      "TOML_INVALID",
      `${key} in stellar.toml must use https (got ${parsed.protocol}).`
    );
  }

  return url.replace(/\/+$/, "");
}

/**
 * Validate a parsed stellar.toml document into an AnchorConfig. Pure, so it
 * is unit-testable without the network.
 */
export function parseAnchorToml(
  doc: TomlDocument,
  options: Required<
    Pick<DiscoverOptions, "homeDomain" | "assetCode" | "networkPassphrase">
  > & { fiatCode: string }
): AnchorConfig {
  const passphrase = readString(doc, "NETWORK_PASSPHRASE");

  if (passphrase && passphrase !== options.networkPassphrase) {
    throw new AnchorError(
      "NETWORK_MISMATCH",
      `${options.homeDomain} is on "${passphrase}" but this build runs on "${options.networkPassphrase}".`,
      {
        hint: "Set VITE_STELLAR_NETWORK to match the anchor, or point VITE_ANCHOR_HOME_DOMAIN at an anchor on this network.",
      }
    );
  }

  const signingKey = readString(doc, "SIGNING_KEY");

  if (!signingKey || !StrKey.isValidEd25519PublicKey(signingKey)) {
    throw new AnchorError(
      "TOML_INVALID",
      "stellar.toml has no valid SIGNING_KEY; SEP-10 challenges cannot be verified."
    );
  }

  const webAuthEndpoint = readString(doc, "WEB_AUTH_ENDPOINT");

  if (!webAuthEndpoint) {
    throw new AnchorError(
      "TOML_INVALID",
      "stellar.toml has no WEB_AUTH_ENDPOINT (SEP-10)."
    );
  }

  const transferServer = readString(doc, "TRANSFER_SERVER");

  if (!transferServer) {
    throw new AnchorError(
      "TOML_INVALID",
      "stellar.toml has no TRANSFER_SERVER (SEP-6). This anchor may only support SEP-24."
    );
  }

  const currencies = Array.isArray(doc.CURRENCIES)
    ? (doc.CURRENCIES as TomlDocument[])
    : [];

  const listed = currencies.find(
    (currency) =>
      readString(currency, "code")?.toUpperCase() ===
      options.assetCode.toUpperCase()
  );

  const issuer = listed ? readString(listed, "issuer") : undefined;

  if (!listed || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) {
    throw new AnchorError(
      "ASSET_NOT_LISTED",
      `${options.assetCode} is not listed with an issuer in ${options.homeDomain}'s stellar.toml.`
    );
  }

  const accounts = Array.isArray(doc.ACCOUNTS)
    ? (doc.ACCOUNTS as unknown[]).filter(
        (value): value is string =>
          typeof value === "string" && StrKey.isValidEd25519PublicKey(value)
      )
    : [];

  const documentation =
    doc.DOCUMENTATION && typeof doc.DOCUMENTATION === "object"
      ? (doc.DOCUMENTATION as TomlDocument)
      : {};

  const validatedAuth = requireHttps(webAuthEndpoint, "WEB_AUTH_ENDPOINT");
  const quoteServer = readString(doc, "ANCHOR_QUOTE_SERVER");
  const kycServer = readString(doc, "KYC_SERVER");

  return {
    homeDomain: options.homeDomain,
    networkPassphrase: options.networkPassphrase,
    signingKey,
    webAuthEndpoint: validatedAuth,
    webAuthDomain: new URL(validatedAuth).host,
    transferServer: requireHttps(transferServer, "TRANSFER_SERVER"),
    quoteServer: quoteServer
      ? requireHttps(quoteServer, "ANCHOR_QUOTE_SERVER")
      : undefined,
    kycServer: kycServer ? requireHttps(kycServer, "KYC_SERVER") : undefined,
    accounts,
    asset: { code: readString(listed, "code") ?? options.assetCode, issuer },
    fiatCode: options.fiatCode,
    orgName: readString(documentation, "ORG_NAME"),
  };
}

const cache = new Map<string, Promise<AnchorConfig>>();

/**
 * Fetch and validate the anchor's stellar.toml. Results are cached per
 * (home domain, asset, network) for the lifetime of the page.
 */
export function discoverAnchor(
  options: DiscoverOptions = {}
): Promise<AnchorConfig> {
  const homeDomain = (options.homeDomain ?? ANCHOR_HOME_DOMAIN)
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  const assetCode = options.assetCode ?? ANCHOR_ASSET_CODE;
  const fiatCode = options.fiatCode ?? ANCHOR_FIAT_CODE;
  const networkPassphrase = options.networkPassphrase ?? NETWORK_PASSPHRASE;

  const key = `${homeDomain}|${assetCode}|${fiatCode}|${networkPassphrase}`;
  const cached = cache.get(key);

  if (cached && !options.force) {
    return cached;
  }

  const pending = (async () => {
    let doc: TomlDocument;

    try {
      doc = (await StellarToml.Resolver.resolve(homeDomain, {
        allowHttp: false,
        timeout: 15_000,
      })) as TomlDocument;
    } catch (error) {
      throw new AnchorError(
        "TOML_UNREACHABLE",
        `Could not load https://${homeDomain}/.well-known/stellar.toml.`,
        { details: error }
      );
    }

    return parseAnchorToml(doc, {
      homeDomain,
      assetCode,
      fiatCode,
      networkPassphrase,
    });
  })();

  cache.set(key, pending);

  // Don't pin a failure: the next call retries.
  pending.catch(() => {
    if (cache.get(key) === pending) {
      cache.delete(key);
    }
  });

  return pending;
}

export function clearAnchorCache(): void {
  cache.clear();
}
