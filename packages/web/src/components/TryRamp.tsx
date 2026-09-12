import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  ANCHOR_HOME_DOMAIN,
  ANCHOR_SANDBOX,
  explorerTxUrl,
} from "../config/stellar";

import { AppError, classifyError } from "../errors";

import {
  STATUS_LABELS,
  beginDeposit,
  connectAnchor,
  discoverAnchor,
  ensureTrustline,
  getAssetHolding,
  isTerminalStatus,
  listTransactions,
  quoteDeposit,
  quoteSecondsLeft,
  quoteWithdraw,
  runWithdraw,
  simulateBankTransfer,
  watchDeposit,
} from "../services/anchor";

import type {
  AnchorConfig,
  AnchorConnection,
  AssetHolding,
  DepositInstructions,
  DepositPhase,
  Quote,
  Sep6Transaction,
  WithdrawPhase,
} from "../services/anchor";

import { signWithWallet } from "../services/wallet";

interface TryRampProps {
  walletAddress: string;
}

type Mode = "deposit" | "withdraw";

type Stage =
  | "idle"
  | "quoting"
  | "running"
  | "awaiting_bank"
  | "done";

/*
 * Banner titles per error kind, mirroring the other cards. ANCHOR covers
 * everything the anchor itself rejects (limits, expired quotes, KYC).
 */
const ERROR_TITLES: Partial<Record<AppError["kind"], string>> = {
  WALLET_NOT_FOUND: "Wallet not found",
  USER_REJECTED: "Request declined in wallet",
  INSUFFICIENT_BALANCE: "Insufficient balance",
  WRONG_NETWORK: "Wrong network",
  ANCHOR: "Anchor error",
};

const DEPOSIT_PHASES: Record<DepositPhase, string> = {
  discovering: "Reading the anchor's stellar.toml (SEP-1)...",
  authenticating: "Sign the SEP-10 login challenge in your wallet...",
  trustline: "Checking the trustline (sign the trustline if prompted)...",
  starting: "Opening the deposit with the anchor (SEP-6)...",
  awaiting_bank: "Waiting for your bank transfer to arrive...",
};

const WITHDRAW_PHASES: Record<WithdrawPhase, string> = {
  discovering: "Reading the anchor's stellar.toml (SEP-1)...",
  authenticating: "Sign the SEP-10 login challenge in your wallet...",
  starting: "Opening the withdrawal with the anchor (SEP-6)...",
  paying: "Sign the payment to the anchor in your wallet...",
  polling: "Waiting for the anchor to pay out...",
};

/** How long the UI keeps polling a deposit while the bank leg is pending. */
const DEPOSIT_WATCH_TIMEOUT_MS = 20 * 60_000;
const WITHDRAW_WATCH_TIMEOUT_MS = 5 * 60_000;

const shorten = (value: string, edge = 6) =>
  value.length > edge * 2 + 3
    ? `${value.slice(0, edge)}...${value.slice(-edge)}`
    : value;

const formatAmount = (value: string | undefined, digits = 2) => {
  if (value === undefined || value === "") {
    return "—";
  }

  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed.toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: 7,
      })
    : value;
};

const statusTone = (status: Sep6Transaction["status"]) =>
  status === "completed"
    ? "tracker-status-completed"
    : isTerminalStatus(status)
      ? "tracker-status-cancelled"
      : "tracker-status-pending";

/**
 * TRY on/off-ramp panel.
 *
 * Deposit: TRY (bank transfer) -> USDC in the connected wallet.
 * Withdraw: USDC from the wallet -> TRY paid out by the anchor. This is the
 * provider payout path: an API provider paid in USDC cashes out to TRY.
 *
 * Only the portable SEP path is used (SEP-1 discovery, SEP-10 login, SEP-38
 * quotes, SEP-6 transfers). No partner API key anywhere.
 */
function TryRamp({ walletAddress }: TryRampProps) {
  const [anchor, setAnchor] = useState<AnchorConfig | null>(null);
  const [anchorError, setAnchorError] = useState<AppError | null>(null);

  const [holding, setHolding] = useState<AssetHolding | null>(null);
  const [holdingBusy, setHoldingBusy] = useState(false);

  const [mode, setMode] = useState<Mode>("deposit");
  const [amount, setAmount] = useState("");

  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteSeconds, setQuoteSeconds] = useState<number | null>(null);

  const [stage, setStage] = useState<Stage>("idle");
  const [phaseLabel, setPhaseLabel] = useState<string | null>(null);

  const [instructions, setInstructions] = useState<DepositInstructions | null>(
    null
  );
  const [transaction, setTransaction] = useState<Sep6Transaction | null>(null);
  const [paymentHash, setPaymentHash] = useState<string | null>(null);
  const [trustlineHash, setTrustlineHash] = useState<string | null>(null);

  const [error, setError] = useState<AppError | null>(null);
  const [simulating, setSimulating] = useState(false);

  const [history, setHistory] = useState<Sep6Transaction[] | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  /** The SEP-10 session in use, kept out of render state. */
  const connectionRef = useRef<AnchorConnection | null>(null);
  /** Aborts an in-flight poll when the user resets or the wallet changes. */
  const abortRef = useRef<AbortController | null>(null);

  const sign = useCallback(
    (xdr: string) => signWithWallet(xdr, walletAddress),
    [walletAddress]
  );

  const fiat = anchor?.fiatCode ?? "TRY";
  const assetCode = anchor?.asset.code ?? "USDC";

  /* ---------------------------------------------------------------- */
  /* Discovery + balance                                              */
  /* ---------------------------------------------------------------- */

  const loadHolding = useCallback(
    async (config: AnchorConfig, isActive: () => boolean = () => true) => {
      setHoldingBusy(true);

      try {
        const result = await getAssetHolding(walletAddress, config.asset);

        if (isActive()) {
          setHolding(result);
        }
      } catch (loadError) {
        if (isActive()) {
          setHolding(null);
          setError(classifyError(loadError));
        }
      } finally {
        if (isActive()) {
          setHoldingBusy(false);
        }
      }
    },
    [walletAddress]
  );

  useEffect(() => {
    let active = true;

    /*
     * SEP-1 discovery is the "subscribe to an external system" case effects
     * exist for; `active` drops a late response after the wallet changes.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAnchorError(null);

    discoverAnchor()
      .then((config) => {
        if (active) {
          setAnchor(config);
          void loadHolding(config, () => active);
        }
      })
      .catch((discoveryError: unknown) => {
        if (active) {
          setAnchor(null);
          setAnchorError(classifyError(discoveryError));
        }
      });

    return () => {
      active = false;
    };
  }, [loadHolding]);

  /* Cancel polling and forget the session when the wallet changes. */
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      connectionRef.current = null;
    };
  }, [walletAddress]);

  /* Quote countdown. */
  useEffect(() => {
    if (!quote) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuoteSeconds(null);
      return;
    }

    const tick = () => setQuoteSeconds(quoteSecondsLeft(quote));

    tick();

    const interval = window.setInterval(tick, 1_000);

    return () => window.clearInterval(interval);
  }, [quote]);

  /* ---------------------------------------------------------------- */
  /* Helpers                                                          */
  /* ---------------------------------------------------------------- */

  const connect = useCallback(async () => {
    const connection = await connectAnchor(walletAddress, sign);

    connectionRef.current = connection;

    return connection;
  }, [walletAddress, sign]);

  const loadHistory = useCallback(async () => {
    setHistoryBusy(true);

    try {
      const { anchor: config, session } = await connect();
      const items = await listTransactions(config, session.token, { limit: 8 });

      setHistory(items);
    } catch (historyError) {
      setError(classifyError(historyError));
    } finally {
      setHistoryBusy(false);
    }
  }, [connect]);

  const reset = () => {
    abortRef.current?.abort();
    abortRef.current = null;

    setStage("idle");
    setPhaseLabel(null);
    setQuote(null);
    setInstructions(null);
    setTransaction(null);
    setPaymentHash(null);
    setTrustlineHash(null);
    setError(null);
  };

  const switchMode = (next: Mode) => {
    if (next !== mode) {
      reset();
      setAmount("");
      setMode(next);
    }
  };

  const validAmount = (): string => {
    const cleaned = amount.trim();
    const decimals = mode === "deposit" ? 2 : 7;

    if (!/^\d+(\.\d+)?$/.test(cleaned) || Number(cleaned) <= 0) {
      throw new Error(
        `Enter a ${mode === "deposit" ? fiat : assetCode} amount greater than 0.`
      );
    }

    if ((cleaned.split(".")[1]?.length ?? 0) > decimals) {
      throw new Error(
        `${mode === "deposit" ? fiat : assetCode} supports at most ${decimals} decimal places.`
      );
    }

    if (
      mode === "withdraw" &&
      holding &&
      Number(cleaned) > Number(holding.balance)
    ) {
      throw new AppError(
        "INSUFFICIENT_BALANCE",
        `Withdrawing ${cleaned} ${assetCode} exceeds your balance of ${holding.balance} ${assetCode}.`,
        "Deposit first, or lower the amount."
      );
    }

    return mode === "deposit" ? Number(cleaned).toFixed(2) : cleaned;
  };

  const busy = stage === "quoting" || stage === "running";

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  const fetchQuote = async () => {
    setError(null);
    setQuote(null);

    let cleaned: string;

    try {
      cleaned = validAmount();
    } catch (validationError) {
      setError(classifyError(validationError));
      return;
    }

    setStage("quoting");
    setPhaseLabel(
      connectionRef.current
        ? "Requesting a firm quote (SEP-38)..."
        : "Sign the SEP-10 login challenge in your wallet..."
    );

    try {
      const { anchor: config, session } = await connect();

      setPhaseLabel("Requesting a firm quote (SEP-38)...");

      const result =
        mode === "deposit"
          ? await quoteDeposit(config, session.token, cleaned)
          : await quoteWithdraw(config, session.token, cleaned);

      setQuote(result);
    } catch (quoteError) {
      setError(classifyError(quoteError));
    } finally {
      setStage("idle");
      setPhaseLabel(null);
    }
  };

  const addTrustline = async () => {
    if (!anchor) {
      return;
    }

    setError(null);
    setStage("running");
    setPhaseLabel("Sign the trustline transaction in your wallet...");

    try {
      const result = await ensureTrustline(walletAddress, anchor.asset, sign);

      if (result.hash) {
        setTrustlineHash(result.hash);
      }

      await loadHolding(anchor);
    } catch (trustError) {
      setError(classifyError(trustError));
    } finally {
      setStage("idle");
      setPhaseLabel(null);
    }
  };

  const startDeposit = async () => {
    let cleaned: string;

    try {
      cleaned = validAmount();
    } catch (validationError) {
      setError(classifyError(validationError));
      return;
    }

    const controller = new AbortController();

    abortRef.current?.abort();
    abortRef.current = controller;

    setError(null);
    setInstructions(null);
    setTransaction(null);
    setTrustlineHash(null);
    setStage("running");

    let started: Awaited<ReturnType<typeof beginDeposit>>;

    try {
      started = await beginDeposit({
        account: walletAddress,
        sign,
        amount: cleaned,
        quoteId: quote?.id,
        signal: controller.signal,
        onPhase: (phase) => setPhaseLabel(DEPOSIT_PHASES[phase]),
      });
    } catch (startError) {
      setError(classifyError(startError));
      setStage("idle");
      setPhaseLabel(null);
      return;
    }

    connectionRef.current = started;

    setInstructions(started.instructions);

    if (started.trustline.hash) {
      setTrustlineHash(started.trustline.hash);
    }

    if (anchor) {
      void loadHolding(anchor);
    }

    setStage("awaiting_bank");
    setPhaseLabel(DEPOSIT_PHASES.awaiting_bank);

    try {
      const completed = await watchDeposit(started, started.instructions.id, {
        account: walletAddress,
        sign,
        signal: controller.signal,
        intervalMs: 3_000,
        timeoutMs: DEPOSIT_WATCH_TIMEOUT_MS,
        onUpdate: (current) => {
          setTransaction(current);

          if (current.status !== "pending_user_transfer_start") {
            setPhaseLabel(STATUS_LABELS[current.status] ?? current.status);
          }
        },
      });

      setTransaction(completed);
      setStage("done");
      setPhaseLabel(null);
      setQuote(null);
      setAmount("");

      if (anchor) {
        await loadHolding(anchor);
      }

      void loadHistory();
    } catch (watchError) {
      if (!controller.signal.aborted) {
        setError(classifyError(watchError));
        setStage("idle");
        setPhaseLabel(null);
      }
    }
  };

  const simulateBank = async () => {
    if (!anchor || !instructions) {
      return;
    }

    setSimulating(true);
    setError(null);

    try {
      const current = await simulateBankTransfer(
        anchor,
        instructions.id,
        transaction?.amountIn
      );

      setTransaction(current);
      setPhaseLabel(STATUS_LABELS[current.status] ?? current.status);
    } catch (simulateError) {
      setError(classifyError(simulateError));
    } finally {
      setSimulating(false);
    }
  };

  const startWithdraw = async () => {
    let cleaned: string;

    try {
      cleaned = validAmount();
    } catch (validationError) {
      setError(classifyError(validationError));
      return;
    }

    const controller = new AbortController();

    abortRef.current?.abort();
    abortRef.current = controller;

    setError(null);
    setTransaction(null);
    setPaymentHash(null);
    setStage("running");

    try {
      const result = await runWithdraw({
        account: walletAddress,
        sign,
        amount: cleaned,
        quoteId: quote?.id,
        signal: controller.signal,
        onPhase: (phase) => setPhaseLabel(WITHDRAW_PHASES[phase]),
        onPayment: (hash) => setPaymentHash(hash),
        poll: {
          intervalMs: 3_000,
          timeoutMs: WITHDRAW_WATCH_TIMEOUT_MS,
          onUpdate: (current) => {
            setTransaction(current);
            setPhaseLabel(STATUS_LABELS[current.status] ?? current.status);
          },
        },
      });

      connectionRef.current = result;

      setTransaction(result.transaction);
      setStage("done");
      setPhaseLabel(null);
      setQuote(null);
      setAmount("");

      if (anchor) {
        await loadHolding(anchor);
      }

      void loadHistory();
    } catch (withdrawError) {
      if (!controller.signal.aborted) {
        setError(classifyError(withdrawError));
        setStage("idle");
        setPhaseLabel(null);
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (busy || stage === "awaiting_bank") {
      return;
    }

    void (mode === "deposit" ? startDeposit() : startWithdraw());
  };

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  const inFlight = busy || stage === "awaiting_bank";
  const quoteExpired = quoteSeconds !== null && quoteSeconds <= 0;

  return (
    <section className="tracker-card ramp-card">
      <div className="tracker-heading">
        <span className="payment-eyebrow">TRY ON/OFF-RAMP · SEP-6</span>

        <h3>
          {fiat} ⇄ {assetCode} via anchor
        </h3>

        <p>
          Portable SEP path: discovery (SEP-1), login with your key (SEP-10),
          firm quotes (SEP-38) and bank transfers (SEP-6). No partner API key.
          Swap the home domain and network in config to go to Mainnet.
        </p>

        <div className="tracker-contract">
          <span className="tracker-contract-label">Anchor</span>

          <code>{ANCHOR_HOME_DOMAIN}</code>

          <a
            href={`https://${ANCHOR_HOME_DOMAIN}/.well-known/stellar.toml`}
            target="_blank"
            rel="noreferrer"
          >
            stellar.toml ↗
          </a>

          {anchor ? (
            <span className="ramp-discovered">
              ✓ {anchor.orgName ?? "discovered"}
            </span>
          ) : anchorError ? null : (
            <span className="ramp-discovering">discovering...</span>
          )}
        </div>
      </div>

      {anchorError && (
        <div className="transaction-result transaction-failure">
          <span className="result-icon">✕</span>

          <div>
            <strong>Anchor unavailable</strong>
            <p>{anchorError.message}</p>
            {anchorError.hint && <p className="error-hint">{anchorError.hint}</p>}
          </div>
        </div>
      )}

      {anchor && (
        <>
          <div className="balance-panel ramp-balance">
            <span className="balance-label">{assetCode} BALANCE</span>

            <strong className="balance-value">
              {holdingBusy && !holding
                ? "Loading..."
                : `${formatAmount(holding?.balance ?? "0", 2)} ${assetCode}`}
            </strong>

            <span className="balance-caption">
              {holding === null
                ? "—"
                : !holding.funded
                  ? "Account not funded on this network yet."
                  : holding.hasTrustline
                    ? `Trustline to ${shorten(anchor.asset.issuer)} active`
                    : `No ${assetCode} trustline yet. It is added automatically on your first deposit.`}
            </span>

            <div className="ramp-balance-actions">
              <button
                className="balance-refresh"
                type="button"
                onClick={() => void loadHolding(anchor)}
                disabled={holdingBusy}
              >
                {holdingBusy ? "Refreshing..." : "Refresh"}
              </button>

              {holding?.funded && !holding.hasTrustline && (
                <button
                  className="balance-refresh"
                  type="button"
                  onClick={() => void addTrustline()}
                  disabled={inFlight}
                >
                  Add {assetCode} trustline
                </button>
              )}
            </div>
          </div>

          <form className="payment-form tracker-form" onSubmit={submit}>
            <div className="tracker-mode">
              <button
                type="button"
                className={`tracker-tab ${mode === "deposit" ? "tracker-tab-active" : ""}`}
                onClick={() => switchMode("deposit")}
                disabled={inFlight}
              >
                Deposit {fiat} → {assetCode}
              </button>

              <button
                type="button"
                className={`tracker-tab ${mode === "withdraw" ? "tracker-tab-active" : ""}`}
                onClick={() => switchMode("withdraw")}
                disabled={inFlight}
              >
                Withdraw {assetCode} → {fiat}
              </button>
            </div>

            <div className="payment-heading">
              <span className="payment-eyebrow">
                {mode === "deposit" ? "ON-RAMP" : "PROVIDER PAYOUT · OFF-RAMP"}
              </span>

              <h4>
                {mode === "deposit"
                  ? `Buy ${assetCode} with a ${fiat} bank transfer`
                  : `Cash out ${assetCode} to ${fiat}`}
              </h4>

              <p>
                {mode === "deposit"
                  ? `The anchor gives you an IBAN and a reference. Send ${fiat} there and ${assetCode} lands in this wallet.`
                  : `${assetCode} is sent to the anchor with its memo; the anchor pays ${fiat} to the bank account on file.`}
              </p>
            </div>

            <label>
              Amount

              <div className="amount-input">
                <input
                  type="number"
                  min={mode === "deposit" ? "0.01" : "0.0000001"}
                  step={mode === "deposit" ? "0.01" : "0.0000001"}
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setQuote(null);
                  }}
                  placeholder={mode === "deposit" ? "250.00" : "5.00"}
                  disabled={inFlight}
                />

                <span>{mode === "deposit" ? fiat : assetCode}</span>
              </div>
            </label>

            {quote && (
              <div className={`ramp-quote ${quoteExpired ? "ramp-quote-expired" : ""}`}>
                <span className="payment-eyebrow">FIRM QUOTE · SEP-38</span>

                <dl>
                  <div>
                    <dt>You send</dt>
                    <dd>
                      {formatAmount(quote.sellAmount, mode === "deposit" ? 2 : 7)}{" "}
                      {mode === "deposit" ? fiat : assetCode}
                    </dd>
                  </div>

                  <div>
                    <dt>You receive</dt>
                    <dd>
                      {formatAmount(quote.buyAmount, mode === "deposit" ? 7 : 2)}{" "}
                      {mode === "deposit" ? assetCode : fiat}
                    </dd>
                  </div>

                  <div>
                    <dt>Rate</dt>
                    <dd>
                      {mode === "deposit"
                        ? `1 ${assetCode} = ${formatAmount(quote.totalPrice ?? quote.price, 4)} ${fiat}`
                        : `1 ${assetCode} = ${formatAmount(
                            String(1 / Number(quote.totalPrice ?? quote.price)),
                            4
                          )} ${fiat}`}
                    </dd>
                  </div>

                  {quote.fee && (
                    <div>
                      <dt>Fee</dt>
                      <dd>
                        {formatAmount(quote.fee.total, 2)}{" "}
                        {quote.fee.asset.split(":")[1] ?? quote.fee.asset}
                        {quote.fee.details?.[0]?.description
                          ? ` (${quote.fee.details[0].description})`
                          : ""}
                      </dd>
                    </div>
                  )}

                  <div>
                    <dt>Valid for</dt>
                    <dd>
                      {quoteExpired
                        ? "expired — request a new quote"
                        : quoteSeconds !== null
                          ? `${Math.floor(quoteSeconds / 60)}m ${quoteSeconds % 60}s`
                          : "—"}
                    </dd>
                  </div>
                </dl>

                <code className="ramp-quote-id">{quote.id}</code>
              </div>
            )}

            <div className="tracker-actions">
              <button
                className="secondary-button tracker-action"
                type="button"
                onClick={() => void fetchQuote()}
                disabled={inFlight || !amount}
              >
                {stage === "quoting" ? "Quoting..." : "Get quote (SEP-38)"}
              </button>

              <button
                className="primary-button tracker-action"
                type="submit"
                disabled={inFlight || !amount || quoteExpired}
              >
                {stage === "running"
                  ? "Waiting for your wallet..."
                  : mode === "deposit"
                    ? `Start deposit${quote ? " at quoted rate" : ""}`
                    : `Withdraw ${assetCode}${quote ? " at quoted rate" : ""}`}
              </button>
            </div>

            {(stage === "awaiting_bank" || stage === "done") && (
              <button
                className="secondary-button tracker-action ramp-reset"
                type="button"
                onClick={reset}
              >
                {stage === "done" ? "Start another" : "Cancel and start over"}
              </button>
            )}
          </form>

          {phaseLabel && (
            <div className="tx-status">
              <span className="tx-status-spinner" />

              <div>
                <strong>{phaseLabel}</strong>

                {trustlineHash && (
                  <a
                    href={explorerTxUrl(trustlineHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Trustline transaction ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {instructions && stage !== "idle" && (
            <div className="ramp-instructions">
              <span className="payment-eyebrow">BANK TRANSFER DETAILS</span>

              <dl>
                {instructions.bankName && (
                  <div>
                    <dt>Bank</dt>
                    <dd>{instructions.bankName}</dd>
                  </div>
                )}

                <div>
                  <dt>IBAN</dt>
                  <dd>
                    <code>{instructions.iban ?? "—"}</code>
                  </dd>
                </div>

                <div>
                  <dt>Reference</dt>
                  <dd>
                    <code>{instructions.reference ?? "—"}</code>
                  </dd>
                </div>

                <div>
                  <dt>Amount</dt>
                  <dd>
                    {formatAmount(transaction?.amountIn ?? amount, 2)} {fiat}
                  </dd>
                </div>

                <div>
                  <dt>Anchor order</dt>
                  <dd>
                    <code>{instructions.id}</code>
                  </dd>
                </div>
              </dl>

              <p className="ramp-note">
                Put the reference in the transfer description (açıklama). It is
                how the anchor routes the money to this wallet.
                {instructions.eta ? ` Typical settlement: ${instructions.eta}s after arrival.` : ""}
              </p>

              {ANCHOR_SANDBOX && stage === "awaiting_bank" && (
                <button
                  className="secondary-button tracker-action"
                  type="button"
                  onClick={() => void simulateBank()}
                  disabled={
                    simulating ||
                    (transaction !== null &&
                      transaction.status !== "pending_user_transfer_start")
                  }
                >
                  {simulating
                    ? "Simulating..."
                    : "Simulate the bank transfer (sandbox)"}
                </button>
              )}
            </div>
          )}

          {transaction && stage !== "idle" && (
            <div className="ramp-timeline">
              <div className="tracker-item-main">
                <span className="tracker-id">
                  {transaction.kind.startsWith("deposit") ? "DEPOSIT" : "WITHDRAWAL"}
                </span>

                <div className="tracker-item-detail">
                  <strong>
                    {formatAmount(transaction.amountIn, 2)}{" "}
                    {transaction.amountInAsset?.split(":")[1] ?? ""} →{" "}
                    {formatAmount(transaction.amountOut, 2)}{" "}
                    {transaction.amountOutAsset?.split(":")[1] ?? ""}
                  </strong>

                  {transaction.message && (
                    <span className="tracker-to">{transaction.message}</span>
                  )}

                  {transaction.amountFee && (
                    <span className="tracker-time">
                      Fee {formatAmount(transaction.amountFee, 2)}{" "}
                      {transaction.amountFeeAsset?.split(":")[1] ?? ""}
                    </span>
                  )}
                </div>

                <span className={`tracker-status ${statusTone(transaction.status)}`}>
                  {STATUS_LABELS[transaction.status] ?? transaction.status}
                </span>
              </div>

              <div className="ramp-links">
                {transaction.stellarTransactionId && (
                  <a
                    href={explorerTxUrl(transaction.stellarTransactionId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Stellar transaction ↗
                  </a>
                )}

                {paymentHash && !transaction.stellarTransactionId && (
                  <a href={explorerTxUrl(paymentHash)} target="_blank" rel="noreferrer">
                    Your {assetCode} payment ↗
                  </a>
                )}

                {transaction.externalTransactionId && (
                  <span className="tracker-time">
                    Bank ref <code>{transaction.externalTransactionId}</code>
                  </span>
                )}

                {transaction.moreInfoUrl && (
                  <a href={transaction.moreInfoUrl} target="_blank" rel="noreferrer">
                    Anchor status page ↗
                  </a>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="transaction-result transaction-failure">
              <span className="result-icon">✕</span>

              <div>
                <strong>{ERROR_TITLES[error.kind] ?? "Something went wrong"}</strong>
                <p>{error.message}</p>
                {error.hint && <p className="error-hint">{error.hint}</p>}
              </div>
            </div>
          )}

          {stage === "done" && transaction && (
            <div className="transaction-result transaction-success">
              <span className="result-icon">✓</span>

              <div>
                <strong>
                  {transaction.kind.startsWith("deposit")
                    ? `${assetCode} credited`
                    : `${fiat} paid out`}
                </strong>

                <p>
                  {transaction.kind.startsWith("deposit")
                    ? `${formatAmount(transaction.amountOut, 7)} ${assetCode} arrived in this wallet for ${formatAmount(transaction.amountIn, 2)} ${fiat}.`
                    : `The anchor paid ${formatAmount(transaction.amountOut, 2)} ${fiat} for ${formatAmount(transaction.amountIn, 7)} ${assetCode}.`}
                </p>
              </div>
            </div>
          )}

          <div className="tracker-list-heading">
            <h4>Ramp history</h4>

            <button
              className="balance-refresh"
              type="button"
              onClick={() => void loadHistory()}
              disabled={historyBusy || inFlight}
            >
              {historyBusy ? "Loading..." : history ? "Refresh" : "Load history"}
            </button>
          </div>

          {history && history.length === 0 && (
            <p className="tracker-empty">No ramps yet for this wallet.</p>
          )}

          {history && history.length > 0 && (
            <ul className="tracker-list">
              {history.map((item) => (
                <li className="tracker-item" key={item.id}>
                  <div className="tracker-item-main">
                    <span className="tracker-id">
                      {item.kind.startsWith("deposit") ? "IN" : "OUT"}
                    </span>

                    <div className="tracker-item-detail">
                      <strong>
                        {formatAmount(item.amountIn, 2)}{" "}
                        {item.amountInAsset?.split(":")[1] ?? ""} →{" "}
                        {formatAmount(item.amountOut, 2)}{" "}
                        {item.amountOutAsset?.split(":")[1] ?? ""}
                      </strong>

                      <span className="tracker-time">
                        {item.startedAt
                          ? new Date(item.startedAt).toLocaleString()
                          : "—"}
                        {item.stellarTransactionId && (
                          <>
                            {" · "}
                            <a
                              href={explorerTxUrl(item.stellarTransactionId)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shorten(item.stellarTransactionId, 6)} ↗
                            </a>
                          </>
                        )}
                      </span>
                    </div>

                    <span className={`tracker-status ${statusTone(item.status)}`}>
                      {STATUS_LABELS[item.status] ?? item.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export default TryRamp;
