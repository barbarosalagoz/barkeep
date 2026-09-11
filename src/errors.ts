/*
 * Centralized error taxonomy for PromptRail.
 *
 * Every failure the app surfaces to the user flows through this module, so
 * each named case has exactly one message and the UI can style them
 * distinctly. The three cases the Yellow Belt review looks for are
 * WALLET_NOT_FOUND, USER_REJECTED, and INSUFFICIENT_BALANCE.
 */

export type AppErrorKind =
  /** The selected wallet extension/app is not installed or not reachable. */
  | "WALLET_NOT_FOUND"
  /** The user declined the connection or signature request in their wallet. */
  | "USER_REJECTED"
  /** The account cannot cover the payment (pre-checked, or on-chain). */
  | "INSUFFICIENT_BALANCE"
  /** The wallet is on a network other than Testnet. */
  | "WRONG_NETWORK"
  /** No wallet connected when one was required. */
  | "NOT_CONNECTED"
  /** The TRY on/off-ramp anchor rejected or could not complete a request. */
  | "ANCHOR"
  /** Anything else. */
  | "UNKNOWN";

export class AppError extends Error {
  readonly kind: AppErrorKind;
  /** Optional follow-up shown under the main message (e.g. install link). */
  readonly hint?: string;

  constructor(kind: AppErrorKind, message: string, hint?: string) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.hint = hint;
  }
}

export const WALLET_INSTALL_URLS: Record<string, string> = {
  freighter: "https://www.freighter.app/",
  xbull: "https://xbull.app/",
  albedo: "https://albedo.link/",
};

export function walletNotFound(walletName?: string): AppError {
  const name = walletName ?? "The selected wallet";
  const key = walletName?.toLowerCase() ?? "";

  return new AppError(
    "WALLET_NOT_FOUND",
    `${name} is not installed or could not be detected in this browser.`,
    WALLET_INSTALL_URLS[key]
      ? `Install it from ${WALLET_INSTALL_URLS[key]} and refresh this page.`
      : "Install the wallet extension (or open its app), then refresh this page."
  );
}

export function userRejected(action: "connection" | "signature"): AppError {
  return new AppError(
    "USER_REJECTED",
    action === "connection"
      ? "You declined the connection request in your wallet."
      : "You declined the signature request in your wallet.",
    "No transaction was submitted. You can try again whenever you're ready."
  );
}

export function insufficientBalance(detail?: string): AppError {
  return new AppError(
    "INSUFFICIENT_BALANCE",
    detail ??
      "Your XLM balance is too low for this payment (keep in mind the network fee and the 1 XLM minimum reserve).",
    "Fund the account with Friendbot at https://lab.stellar.org/account/fund and try again."
  );
}

/* ------------------------------------------------------------------ */
/* Classification of raw failures                                      */
/* ------------------------------------------------------------------ */

const REJECTION_PATTERNS = [
  "reject",
  "declin",
  "denied",
  "cancel",
  "abort",
  "dismiss",
  "closed by user",
  "user closed",
];

const NOT_FOUND_PATTERNS = [
  "not installed",
  "not available",
  "unavailable",
  "not found",
  "no extension",
  "is not detected",
  "undetected",
];

const UNDERFUNDED_PATTERNS = [
  "op_underfunded",
  "tx_insufficient_balance",
  "underfunded",
  "insufficient balance",
  "balance is not sufficient",
  "resulting balance is not within the allowed range",
];

/*
 * Soroban contract error codes, mirrored from
 * contracts/payment-tracker/src/lib.rs. Failures surface as
 * "Error(Contract, #N)".
 */
const CONTRACT_ERRORS: Record<number, string> = {
  1: "The contract has already been initialized.",
  2: "The contract has no settlement token configured.",
  3: "Amount must be greater than zero.",
  4: "No payment exists with that id.",
  5: "That payment is already completed or cancelled.",
  6: "Add at least one recipient.",
  7: "Too many recipients in a single batch (max 100).",
  8: "Sender and recipient cannot be the same address.",
};

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Map any raw failure (wallet kit, RPC, Horizon, contract) onto the app's
 * error taxonomy. Idempotent: an AppError passes through unchanged.
 */
export function classifyError(error: unknown, walletName?: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = rawMessage(error);
  const normalized = message.toLowerCase();

  if (REJECTION_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return userRejected(
      normalized.includes("connect") ? "connection" : "signature"
    );
  }

  if (NOT_FOUND_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return walletNotFound(walletName);
  }

  if (UNDERFUNDED_PATTERNS.some((pattern) => normalized.includes(pattern))) {
    return insufficientBalance();
  }

  const contractMatch = message.match(/Error\(Contract,\s*#(\d+)\)/);

  if (contractMatch) {
    const code = Number(contractMatch[1]);

    return new AppError(
      "UNKNOWN",
      CONTRACT_ERRORS[code] ?? `Contract rejected the call (error #${code}).`
    );
  }

  return new AppError("UNKNOWN", message || "Something went wrong.");
}

/**
 * Map Horizon submit failures (result codes) onto the taxonomy. Falls back to
 * classifyError for anything that isn't a Horizon response.
 */
export function classifyHorizonError(error: unknown): AppError {
  const horizonError = error as {
    response?: {
      data?: {
        extras?: {
          result_codes?: { transaction?: string; operations?: string[] };
        };
      };
    };
  };

  const resultCodes = horizonError.response?.data?.extras?.result_codes;

  if (resultCodes) {
    const codes = [
      resultCodes.transaction ?? "",
      ...(resultCodes.operations ?? []),
    ]
      .join(",")
      .toLowerCase();

    if (
      codes.includes("op_underfunded") ||
      codes.includes("tx_insufficient_balance") ||
      codes.includes("tx_insufficient_fee")
    ) {
      return insufficientBalance();
    }

    const operationCode = resultCodes.operations?.join(", ");

    return new AppError(
      "UNKNOWN",
      operationCode
        ? `Stellar rejected the transaction: ${operationCode}`
        : `Stellar rejected the transaction: ${
            resultCodes.transaction ?? "unknown error"
          }`
    );
  }

  return classifyError(error);
}
