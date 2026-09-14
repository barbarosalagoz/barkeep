/*
 * Token amounts. Base units (stroops) are bigint; anything shown to a person
 * is a decimal string with the token's symbol on it, so a Testnet test asset
 * is never mistaken for USDC.
 */

/** Decimal string in token units -> base units, without floating point. */
export function toBaseUnits(amount: string, decimals: number, label = "limit"): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());

  if (!m) throw new Error(`${label} must be a positive decimal string; got "${amount}"`);

  const frac = (m[2] ?? "").padEnd(decimals, "0");
  if (frac.length > decimals) {
    throw new Error(`${label} has more than ${decimals} decimal places: "${amount}"`);
  }

  const value = BigInt(m[1] + frac);
  if (value <= 0n) throw new Error(`${label} must be greater than zero; got "${amount}"`);
  return value;
}

export function fromBaseUnits(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const s = (neg ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, -decimals || undefined);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";

  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** An amount with its token symbol: "0.0001 TAB". */
export const withUnit = (value: bigint, cfg: { tokenDecimals: number; tokenSymbol: string }): string =>
  `${fromBaseUnits(value, cfg.tokenDecimals)} ${cfg.tokenSymbol}`;
