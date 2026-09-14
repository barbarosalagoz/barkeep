import { describe, expect, it } from "vitest";

import { fromBaseUnits, toBaseUnits, withUnit } from "./units.ts";

describe("amounts", () => {
  it("always carry the token symbol", () => {
    expect(withUnit(1000n, { tokenDecimals: 7, tokenSymbol: "TAB" })).toBe("0.0001 TAB");
    expect(withUnit(0n, { tokenDecimals: 7, tokenSymbol: "TAB" })).toBe("0 TAB");
  });

  it("round-trip through base units without floating point", () => {
    expect(toBaseUnits("0.0005", 7)).toBe(5000n);
    expect(toBaseUnits("1", 7)).toBe(10_000_000n);
    expect(fromBaseUnits(4500n, 7)).toBe("0.00045");
    expect(fromBaseUnits(-1n, 7)).toBe("-0.0000001");
    expect(fromBaseUnits(12n, 0)).toBe("12");
  });

  it("refuse zero, negatives and too many decimals", () => {
    expect(() => toBaseUnits("0", 7)).toThrow(/greater than zero/);
    expect(() => toBaseUnits("-1", 7)).toThrow(/positive decimal/);
    expect(() => toBaseUnits("0.00000001", 7, "max_amount")).toThrow(/max_amount has more than 7 decimal places/);
  });
});
