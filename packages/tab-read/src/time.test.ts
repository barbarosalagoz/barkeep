import { describe, expect, it } from "vitest";

import { describeExpiry, describeWindow, ledgersToWindow, windowToLedgers } from "./time.ts";

describe("time", () => {
  it("shows the window as asked and in ledgers", () => {
    expect(describeWindow("PT1H", 720)).toBe("PT1H (720 ledgers)");
    expect(ledgersToWindow(720)).toBe("PT1H");
    expect(ledgersToWindow(180)).toBe("PT15M");
    expect(ledgersToWindow(17280)).toBe("P1D");
    expect(describeWindow(undefined, 18)).toBe("PT1M30S (18 ledgers)");
  });

  it("turns a duration into ledgers, and refuses what is not one", () => {
    expect(windowToLedgers("PT1H")).toBe(720);
    expect(windowToLedgers("PT1S")).toBe(1);
    expect(() => windowToLedgers("1h")).toThrow(/ISO-8601/);
    expect(() => windowToLedgers("PT0S")).toThrow(/greater than zero/);
  });

  it("shows expiry as a ledger and a rough time", () => {
    expect(describeExpiry(4653477, 4652761)).toBe("at ledger 4653477, in ~60 min (716 ledgers)");
    expect(describeExpiry(100, 112)).toBe("at ledger 100, ~1 min ago (12 ledgers)");
  });
});
