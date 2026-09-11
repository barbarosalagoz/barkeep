import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import {
  Horizon,
  Asset,
  BASE_FEE,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import {
  connectWallet as kitConnect,
  disconnectWallet as kitDisconnect,
  getWalletNetwork,
  getWalletOptions,
  signWithWallet,
} from "./services/wallet";
import type { WalletOption } from "./services/wallet";

import {
  AppError,
  classifyError,
  classifyHorizonError,
  insufficientBalance,
} from "./errors";

import PaymentTracker from "./components/PaymentTracker";
import TryRamp from "./components/TryRamp";

import "./App.css";

const horizonServer = new Horizon.Server(
  "https://horizon-testnet.stellar.org"
);

/*
 * Banner titles per error kind, so the three review-relevant cases —
 * wallet not found, user rejected, insufficient balance — read
 * distinctly in the UI.
 */
const ERROR_TITLES: Partial<
  Record<AppError["kind"], string>
> = {
  WALLET_NOT_FOUND:
    "Wallet not found",
  USER_REJECTED:
    "Request declined in wallet",
  INSUFFICIENT_BALANCE:
    "Insufficient balance",
  WRONG_NETWORK:
    "Wrong network",
};

function App() {
  const [walletOptions, setWalletOptions] =
    useState<WalletOption[] | null>(null);

  const [walletAddress, setWalletAddress] =
    useState<string | null>(null);

  const [connecting, setConnecting] =
    useState(false);

  const [connectionError, setConnectionError] =
    useState<AppError | null>(null);

  const [network, setNetwork] =
    useState<string | null>(null);

  const [xlmBalance, setXlmBalance] =
    useState<string | null>(null);

  const [balanceLoading, setBalanceLoading] =
    useState(false);

  const [balanceError, setBalanceError] =
    useState<string | null>(null);

  const [destination, setDestination] =
    useState("");

  const [amount, setAmount] =
    useState("");

  const [sending, setSending] =
    useState(false);

  const [transactionError, setTransactionError] =
    useState<AppError | null>(null);

  const [transactionHash, setTransactionHash] =
    useState<string | null>(null);

  /*
   * Discover which wallets the kit can offer in this browser, so the UI can
   * show availability and install guidance before a connect attempt.
   */
  useEffect(() => {
    let active = true;

    getWalletOptions()
      .then((options) => {
        if (active) {
          setWalletOptions(options);
        }
      })
      .catch((error) => {
        console.error(
          "Wallet discovery failed:",
          error
        );

        if (active) {
          setWalletOptions([]);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  /*
   * Read the connected wallet's active network through the kit. Returns
   * "TESTNET" when the passphrase matches, else the wallet's own label.
   */
  const checkNetwork = async () => {
    const details =
      await getWalletNetwork();

    const label =
      details.networkPassphrase ===
      Networks.TESTNET
        ? "TESTNET"
        : details.network ||
          "UNKNOWN";

    setNetwork(label);

    return label;
  };

  /*
   * Fetch XLM balance from Horizon Testnet
   */
  const fetchBalance = async (
    address: string
  ) => {
    try {
      setBalanceLoading(true);
      setBalanceError(null);

      const account =
        await horizonServer.loadAccount(
          address
        );

      const nativeBalance =
        account.balances.find(
          (balance) =>
            balance.asset_type ===
            "native"
        );

      if (!nativeBalance) {
        setXlmBalance("0");
        return;
      }

      setXlmBalance(
        nativeBalance.balance
      );
    } catch (error) {
      console.error(
        "Balance fetch failed:",
        error
      );

      setXlmBalance(null);

      const possibleError = error as {
        response?: {
          status?: number;
        };
      };

      if (
        possibleError.response?.status ===
        404
      ) {
        setBalanceError(
          "This wallet is not funded on Stellar Testnet yet."
        );
      } else {
        setBalanceError(
          "Could not fetch your XLM balance from Stellar Testnet."
        );
      }
    } finally {
      setBalanceLoading(false);
    }
  };

  /*
   * Connect through the kit's wallet-selection modal (Freighter,
   * Albedo). The service enforces Testnet and raises typed AppErrors, so
   * wallet-not-found and user-rejected surface as distinct messages.
   */
  const connectWallet = async () => {
    try {
      setConnecting(true);

      setConnectionError(null);
      setBalanceError(null);

      const connected =
        await kitConnect();

      setWalletAddress(
        connected.address
      );

      setNetwork(
        connected.networkPassphrase ===
          Networks.TESTNET
          ? "TESTNET"
          : connected.network
      );

      await fetchBalance(
        connected.address
      );
    } catch (error) {
      console.error(
        "Wallet connection failed:",
        error
      );

      setConnectionError(
        classifyError(error)
      );
    } finally {
      setConnecting(false);
    }
  };

  /*
   * Disconnect from PromptRail UI
   */
  const disconnectWallet = () => {
    void kitDisconnect();

    setWalletAddress(null);
    setNetwork(null);
    setXlmBalance(null);

    setConnectionError(null);
    setBalanceError(null);

    setDestination("");
    setAmount("");

    setTransactionHash(null);
    setTransactionError(null);
  };

  /*
   * Recheck network
   */
  const recheckNetwork = async () => {
    try {
      setConnectionError(null);
      setBalanceError(null);

      const activeNetwork =
        await checkNetwork();

      if (
        activeNetwork !== "TESTNET"
      ) {
        setXlmBalance(null);

        setConnectionError(
          new AppError(
            "WRONG_NETWORK",
            `PromptRail requires Stellar Testnet. Your wallet is currently on ${activeNetwork}.`,
            "Switch the wallet to Testnet, then press Recheck Network."
          )
        );

        return;
      }

      if (walletAddress) {
        await fetchBalance(
          walletAddress
        );
      }
    } catch (error) {
      setConnectionError(
        classifyError(error)
      );
    }
  };

  /*
   * Refresh XLM balance
   */
  const refreshBalance = async () => {
    if (
      !walletAddress ||
      network !== "TESTNET"
    ) {
      return;
    }

    await fetchBalance(
      walletAddress
    );
  };

  /*
   * Send XLM on Stellar Testnet
   */
  const sendXlm = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (!walletAddress) {
      return;
    }

    try {
      setSending(true);

      setTransactionError(null);
      setTransactionHash(null);

      /*
       * 1. Verify Testnet
       */
      const activeNetwork =
        await checkNetwork();

      if (
        activeNetwork !== "TESTNET"
      ) {
        throw new AppError(
          "WRONG_NETWORK",
          "Switch your wallet to Stellar Testnet before sending XLM."
        );
      }

      /*
       * 2. Validate recipient
       */
      const cleanDestination =
        destination.trim();

      if (
        !StrKey.isValidEd25519PublicKey(
          cleanDestination
        )
      ) {
        throw new Error(
          "Enter a valid Stellar G... address."
        );
      }

      if (
        cleanDestination ===
        walletAddress
      ) {
        throw new Error(
          "Please use a different Testnet account as the recipient."
        );
      }

      /*
       * 3. Validate amount
       */
      const cleanAmount =
        amount.trim();

      const numericAmount =
        Number(cleanAmount);

      if (
        !Number.isFinite(
          numericAmount
        ) ||
        numericAmount <= 0
      ) {
        throw new Error(
          "Enter an XLM amount greater than 0."
        );
      }

      const decimalPlaces =
        cleanAmount.split(".")[1]
          ?.length ?? 0;

      if (decimalPlaces > 7) {
        throw new Error(
          "XLM supports a maximum of 7 decimal places."
        );
      }

      /*
       * Insufficient balance is pre-checked here, before any signing prompt.
       * If it slips through anyway, the Horizon result code maps to the same
       * typed error in the catch below.
       */
      if (
        xlmBalance &&
        numericAmount >=
          Number(xlmBalance)
      ) {
        throw insufficientBalance(
          `This payment (${numericAmount} XLM) exceeds your spendable balance of ${xlmBalance} XLM.`
        );
      }

      /*
       * 4. Recipient must already exist
       * on Testnet for a normal payment.
       */
      try {
        await horizonServer.loadAccount(
          cleanDestination
        );
      } catch {
        throw new Error(
          "Recipient account is not funded on Stellar Testnet. Fund the recipient first."
        );
      }

      /*
       * 5. Load source account
       */
      const sourceAccount =
        await horizonServer.loadAccount(
          walletAddress
        );

      /*
       * 6. Build payment transaction
       */
      const transaction =
        new TransactionBuilder(
          sourceAccount,
          {
            fee: BASE_FEE,
            networkPassphrase:
              Networks.TESTNET,
          }
        )
          .addOperation(
            Operation.payment({
              destination:
                cleanDestination,

              asset:
                Asset.native(),

              amount:
                numericAmount.toFixed(
                  Math.max(
                    1,
                    decimalPlaces
                  )
                ),
            })
          )
          .addMemo(
            Memo.text(
              "PromptRail Yellow Belt"
            )
          )
          .setTimeout(30)
          .build();

      /*
       * 7. Convert transaction to Base64 XDR
       *
       * IMPORTANT:
       * Current installed SDK uses toXdr(),
       * not toXDR().
       */
      const unsignedXdr =
        transaction.toEnvelope().toXdr("base64");

      /*
       * 8. Ask the connected wallet to sign (any kit wallet: Freighter,
       * Albedo). A decline raises a typed USER_REJECTED error.
       */
      const signedXdr =
        await signWithWallet(
          unsignedXdr,
          walletAddress
        );

      /*
       * 9. Convert signed XDR back
       * into a Stellar transaction
       *
       * IMPORTANT:
       * Current installed SDK uses fromXdr(),
       * not fromXDR().
       */
      const signedTransaction =
        TransactionBuilder.fromXdr(
          signedXdr,
          Networks.TESTNET
        );

      /*
       * 10. Submit to Stellar Testnet
       */
      const result =
        await horizonServer.submitTransaction(
          signedTransaction
        );

      /*
       * 11. Success
       */
      setTransactionHash(
        result.hash
      );

      setAmount("");

      await fetchBalance(
        walletAddress
      );
    } catch (error) {
      console.error(
        "Transaction failed:",
        error
      );

      /*
       * classifyHorizonError maps op_underfunded and
       * tx_insufficient_balance/fee to INSUFFICIENT_BALANCE, wallet declines
       * to USER_REJECTED, and everything else to a readable message.
       */
      setTransactionError(
        classifyHorizonError(error)
      );
    } finally {
      setSending(false);
    }
  };

  const isTestnet =
    network === "TESTNET";

  return (
    <main className="app">
      <header className="navbar">
        <div className="brand">
          <div className="brand-mark">
            P
          </div>

          <div>
            <h1>PromptRail</h1>

            <span>
              Machine Payments on Stellar
            </span>
          </div>
        </div>

        <div
          className={`network-badge ${
            network && !isTestnet
              ? "network-badge-wrong"
              : ""
          }`}
        >
          <span
            className={`network-dot ${
              network && !isTestnet
                ? "network-dot-wrong"
                : ""
            }`}
          />

          {network ?? "TESTNET"}
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow">
          STELLAR YELLOW BELT
        </div>

        <h2>
          The payment rail
          <br />
          for the agentic web.
        </h2>

        <p>
          Connect your Stellar wallet
          and make your first
          machine-to-machine payment
          on Testnet.
        </p>
      </section>

      <section className="wallet-card">
        <div className="card-icon">
          ✦
        </div>

        {walletAddress ? (
          <>
            <h3>
              Wallet connected
            </h3>

            <p>
              Your Stellar wallet
              is connected to
              PromptRail.
            </p>

            <div className="connected-status">
              <span className="connected-dot" />
              Connected
            </div>

            <div className="wallet-address">
              <span className="wallet-address-label">
                Stellar Address
              </span>

              <strong>
                {walletAddress.slice(
                  0,
                  10
                )}
                ...
                {walletAddress.slice(
                  -10
                )}
              </strong>
            </div>

            {isTestnet && (
              <div className="balance-panel">
                <span className="balance-label">
                  XLM BALANCE
                </span>

                {balanceLoading ? (
                  <strong className="balance-value">
                    Loading...
                  </strong>
                ) : xlmBalance ? (
                  <>
                    <strong className="balance-value">
                      {Number(
                        xlmBalance
                      ).toLocaleString(
                        undefined,
                        {
                          minimumFractionDigits:
                            2,
                          maximumFractionDigits:
                            7,
                        }
                      )}{" "}
                      XLM
                    </strong>

                    <span className="balance-caption">
                      Stellar Testnet
                      balance
                    </span>
                  </>
                ) : (
                  <strong className="balance-value">
                    — XLM
                  </strong>
                )}

                <button
                  className="balance-refresh"
                  onClick={
                    refreshBalance
                  }
                  disabled={
                    balanceLoading
                  }
                >
                  {balanceLoading
                    ? "Refreshing..."
                    : "Refresh Balance"}
                </button>
              </div>
            )}

            {balanceError && (
              <div className="balance-error">
                <strong>
                  Wallet not funded
                </strong>

                <span>
                  {balanceError}
                </span>
              </div>
            )}

            {network && (
              <div
                className={`network-panel ${
                  isTestnet
                    ? "network-panel-good"
                    : "network-panel-wrong"
                }`}
              >
                <span className="network-panel-label">
                  ACTIVE NETWORK
                </span>

                <strong>
                  {isTestnet
                    ? "✓ Stellar Testnet"
                    : `⚠ ${network}`}
                </strong>

                <span>
                  {isTestnet
                    ? "Ready for test transactions."
                    : "Switch your wallet to Testnet before continuing."}
                </span>
              </div>
            )}

            {isTestnet &&
              xlmBalance && (
                <form
                  className="payment-form"
                  onSubmit={sendXlm}
                >
                  <div className="payment-heading">
                    <span className="payment-eyebrow">
                      MACHINE PAYMENT
                    </span>

                    <h4>
                      Send Testnet XLM
                    </h4>

                    <p>
                      Create, sign and
                      submit a real
                      Stellar payment.
                    </p>
                  </div>

                  <label>
                    Recipient

                    <input
                      type="text"
                      value={
                        destination
                      }
                      onChange={(
                        event
                      ) =>
                        setDestination(
                          event.target
                            .value
                        )
                      }
                      placeholder="G..."
                      autoComplete="off"
                      disabled={
                        sending
                      }
                    />
                  </label>

                  <label>
                    Amount

                    <div className="amount-input">
                      <input
                        type="number"
                        min="0.0000001"
                        step="0.0000001"
                        value={
                          amount
                        }
                        onChange={(
                          event
                        ) =>
                          setAmount(
                            event.target
                              .value
                          )
                        }
                        placeholder="1.00"
                        disabled={
                          sending
                        }
                      />

                      <span>
                        XLM
                      </span>
                    </div>
                  </label>

                  <button
                    className="primary-button"
                    type="submit"
                    disabled={
                      sending ||
                      !destination ||
                      !amount
                    }
                  >
                    {sending
                      ? "Waiting for your wallet..."
                      : "Send XLM"}
                  </button>
                </form>
              )}

            {transactionError && (
              <div className="transaction-result transaction-failure">
                <span className="result-icon">
                  ✕
                </span>

                <div>
                  <strong>
                    {ERROR_TITLES[
                      transactionError
                        .kind
                    ] ??
                      "Transaction failed"}
                  </strong>

                  <p>
                    {
                      transactionError.message
                    }
                  </p>

                  {transactionError.hint && (
                    <p className="error-hint">
                      {
                        transactionError.hint
                      }
                    </p>
                  )}
                </div>
              </div>
            )}

            {transactionHash && (
              <div className="transaction-result transaction-success">
                <span className="result-icon">
                  ✓
                </span>

                <div>
                  <strong>
                    Payment successful
                  </strong>

                  <p>
                    Your XLM payment
                    was confirmed on
                    Stellar Testnet.
                  </p>

                  <span className="hash-label">
                    TRANSACTION HASH
                  </span>

                  <code>
                    {transactionHash.slice(
                      0,
                      12
                    )}
                    ...
                    {transactionHash.slice(
                      -12
                    )}
                  </code>

                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${transactionHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View transaction ↗
                  </a>
                </div>
              </div>
            )}

            <button
              className="secondary-button"
              onClick={
                recheckNetwork
              }
            >
              Recheck Network
            </button>

            <button
              className="disconnect-button"
              onClick={
                disconnectWallet
              }
            >
              Disconnect Wallet
            </button>
          </>
        ) : (
          <>
            <h3>
              Connect your wallet
            </h3>

            <p>
              Pick a Stellar wallet
              — Freighter or Albedo
              — to access your
              Testnet account.
            </p>

            <button
              className="primary-button"
              onClick={
                connectWallet
              }
              disabled={
                connecting ||
                walletOptions ===
                  null
              }
            >
              {walletOptions ===
              null
                ? "Detecting wallets..."
                : connecting
                  ? "Connecting..."
                  : "Connect Wallet"}
            </button>

            {walletOptions && (
              <ul className="wallet-availability">
                {walletOptions.map(
                  (option) => (
                    <li
                      key={
                        option.id
                      }
                      className={
                        option.available
                          ? "wallet-available"
                          : "wallet-missing"
                      }
                    >
                      <span className="wallet-availability-dot" />

                      {option.name}

                      {option.available ? (
                        <em>
                          detected
                        </em>
                      ) : (
                        <a
                          href={
                            option.url
                          }
                          target="_blank"
                          rel="noreferrer"
                        >
                          install ↗
                        </a>
                      )}
                    </li>
                  )
                )}
              </ul>
            )}
          </>
        )}

        {connectionError && (
          <div className="connection-error">
            <strong>
              {ERROR_TITLES[
                connectionError
                  .kind
              ] ??
                "Connection failed"}
            </strong>

            <p>
              {
                connectionError.message
              }
            </p>

            {connectionError.hint && (
              <p className="error-hint">
                {
                  connectionError.hint
                }
              </p>
            )}
          </div>
        )}

        <span className="card-note">
          Your private keys never
          leave your wallet.
        </span>
      </section>

      {walletAddress && isTestnet && (
        <PaymentTracker
          walletAddress={
            walletAddress
          }
          xlmBalance={xlmBalance}
        />
      )}

      {walletAddress && isTestnet && (
        <TryRamp
          walletAddress={
            walletAddress
          }
        />
      )}

      <footer>
        Built on Stellar ·
        PromptRail Launchpad ·{" "}
        <a
          href={`${import.meta.env.BASE_URL}third-party-licenses.txt`}
        >
          Third-party licenses
        </a>
      </footer>
    </main>
  );
}

export default App;