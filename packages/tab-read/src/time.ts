/*
 * Ledgers are the clock. A tab's window and expiry are ledger counts on chain;
 * these turn them into the durations a person asked for, and back.
 */

/** Testnet closes a ledger roughly every 5 seconds. */
export const SECONDS_PER_LEDGER = 5;

/** ISO-8601 duration -> ledgers. Supports the subset a tab window needs. */
export function windowToLedgers(window: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(window.trim());

  if (!m || m.slice(1).every((v) => v === undefined)) {
    throw new Error(
      `window must be an ISO-8601 duration such as PT1H, PT30M or P1D; got "${window}"`
    );
  }

  const [d, h, min, s] = m.slice(1).map((v) => (v ? Number(v) : 0));
  const seconds = d * 86400 + h * 3600 + min * 60 + s;

  if (seconds <= 0) throw new Error(`window must be greater than zero; got "${window}"`);
  return Math.max(1, Math.ceil(seconds / SECONDS_PER_LEDGER));
}

/** Ledgers -> an ISO-8601 duration at SECONDS_PER_LEDGER, for tabs that predate storing `window`. */
export function ledgersToWindow(ledgers: number): string {
  let s = ledgers * SECONDS_PER_LEDGER;
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const time = `${h ? `${h}H` : ""}${m ? `${m}M` : ""}${s ? `${s}S` : ""}`;
  const iso = `P${d ? `${d}D` : ""}${time ? `T${time}` : ""}`;
  return iso === "P" ? "PT0S" : iso;
}

/** "PT1H (720 ledgers)": the window as asked, and what the chain counts. */
export const describeWindow = (window: string | undefined, ledgers: number): string =>
  `${window ?? ledgersToWindow(ledgers)} (${ledgers} ledgers)`;

/** "at ledger 4653477, in ~60 min (716 ledgers)", or how long ago it passed. */
export function describeExpiry(expiryLedger: number, currentLedger: number): string {
  const left = expiryLedger - currentLedger;
  const minutes = Math.round((Math.abs(left) * SECONDS_PER_LEDGER) / 60);
  return left >= 0
    ? `at ledger ${expiryLedger}, in ~${minutes} min (${left} ledgers)`
    : `at ledger ${expiryLedger}, ~${minutes} min ago (${-left} ledgers)`;
}
