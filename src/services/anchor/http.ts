/*
 * Minimal JSON transport for SEP endpoints.
 *
 * Every anchor call goes through anchorFetch so error bodies are mapped onto
 * AnchorError codes in one place. The SEP specs use a few shapes:
 *   { "error": "message" }                                  most failures
 *   { "type": "authentication_required" }                   SEP-6 403
 *   { "type": "non_interactive_customer_info_needed", ... } SEP-6 403 (KYC)
 *   { "type": "customer_info_status", "status": "pending" } SEP-6 403 (KYC)
 */

import { AnchorError } from "./errors";
import type { AnchorErrorCode } from "./errors";

export type QueryValue = string | number | boolean | undefined | null;

export interface AnchorRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  token?: string;
  signal?: AbortSignal;
}

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");

  return `${trimmedBase}/${trimmedPath}`;
}

export function withQuery(
  url: string,
  query: Record<string, QueryValue> | undefined
): string {
  if (!query) {
    return url;
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      params.set(key, String(value));
    }
  }

  const encoded = params.toString();

  return encoded ? `${url}${url.includes("?") ? "&" : "?"}${encoded}` : url;
}

interface ErrorBody {
  error?: unknown;
  message?: unknown;
  type?: unknown;
  status?: unknown;
  fields?: unknown;
}

function extractMessage(body: ErrorBody | null, fallback: string): string {
  if (!body) {
    return fallback;
  }

  if (typeof body.error === "string") {
    return body.error;
  }

  if (body.error && typeof body.error === "object") {
    const nested = body.error as { message?: unknown; code?: unknown };

    if (typeof nested.message === "string") {
      return nested.message;
    }

    if (typeof nested.code === "string") {
      return nested.code;
    }
  }

  if (typeof body.message === "string") {
    return body.message;
  }

  return fallback;
}

export function classifyStatus(
  status: number,
  body: ErrorBody | null,
  message: string
): AnchorErrorCode {
  const type = typeof body?.type === "string" ? body.type : "";

  if (type === "authentication_required" || status === 401) {
    return "AUTH_REQUIRED";
  }

  if (
    type === "non_interactive_customer_info_needed" ||
    type === "customer_info_status"
  ) {
    return "KYC_REQUIRED";
  }

  if (status === 404) {
    return "NOT_FOUND";
  }

  if (/expired/i.test(message) && /quote/i.test(message)) {
    return "QUOTE_EXPIRED";
  }

  if (status === 403) {
    return "AUTH_REQUIRED";
  }

  return "ANCHOR_REJECTED";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Perform a request against an anchor endpoint and return the parsed JSON.
 * Non-2xx responses throw an AnchorError carrying the anchor's message.
 */
export async function anchorFetch<T>(
  url: string,
  request: AnchorRequest = {}
): Promise<T> {
  const method = request.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };

  if (request.token) {
    headers.Authorization = `Bearer ${request.token}`;
  }

  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;

  try {
    response = await fetch(withQuery(url, request.query), {
      method,
      headers,
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: request.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new AnchorError("CANCELLED", "The anchor request was cancelled.");
    }

    throw new AnchorError(
      "ANCHOR_REJECTED",
      `Could not reach the anchor at ${hostOf(url)}.`,
      { details: error }
    );
  }

  const text = await response.text();
  let parsed: unknown = null;

  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    const body = (
      parsed && typeof parsed === "object" ? parsed : null
    ) as ErrorBody | null;

    const message = extractMessage(
      body,
      text ? text.slice(0, 200) : `HTTP ${response.status}`
    );

    throw new AnchorError(
      classifyStatus(response.status, body, message),
      message,
      { status: response.status, details: body ?? text }
    );
  }

  if (parsed === null && text) {
    throw new AnchorError(
      "ANCHOR_REJECTED",
      `The anchor returned a non-JSON response (${hostOf(url)}).`,
      { status: response.status, details: text.slice(0, 200) }
    );
  }

  return parsed as T;
}
