import { describe, it, expect } from "vitest";
import {
  CRYPTO_SESSION_CUTOFF_UTC,
  isCryptoFamily,
  cryptoSessionDate,
  cryptoCompletedCandles,
  assertNotCryptoFamily,
} from "./crypto-session";
import { completedSessionCandles } from "./completed-candles";

describe("isCryptoFamily", () => {
  it("true for crypto only", () => {
    expect(isCryptoFamily("crypto")).toBe(true);
    expect(isCryptoFamily("operating_company")).toBe(false);
    expect(isCryptoFamily("broad_equity_etf")).toBe(false);
    expect(isCryptoFamily("unknown")).toBe(false);
  });
});

describe("CRYPTO_SESSION_CUTOFF_UTC", () => {
  it("is midnight (0)", () => {
    // ponytail: if this changes, every forward-return label needs recomputing
    expect(CRYPTO_SESSION_CUTOFF_UTC).toBe(0);
  });
});

describe("cryptoSessionDate", () => {
  it("returns the preceding UTC date immediately after midnight", () => {
    // 00:01 UTC on 2026-09-04: the 2026-09-04 bar has just opened.
    const at = new Date("2026-09-04T00:01:00Z");
    expect(cryptoSessionDate(at)).toBe("2026-09-03");
  });

  it("does not expose the still-accumulating current UTC bar", () => {
    // 23:59 UTC on 2026-09-03 — the 2026-09-03 bar is still live.
    const at = new Date("2026-09-03T23:59:59Z");
    expect(cryptoSessionDate(at)).toBe("2026-09-02");
  });

  it("handles midnight exactly without admitting the new bar", () => {
    const at = new Date("2026-09-04T00:00:00Z");
    expect(cryptoSessionDate(at)).toBe("2026-09-03");
  });
});

describe("cryptoCompletedCandles", () => {
  const candles = [
    { date: "2026-09-02" },
    { date: "2026-09-03" },
    { date: "2026-09-04" },
    { date: "2026-09-05" }, // future
  ];

  it("drops future dates", () => {
    const now = new Date("2026-09-04T12:00:00Z");
    const result = cryptoCompletedCandles(candles, now);
    expect(result.map((c) => c.date)).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("returns empty array when all candles are future", () => {
    const now = new Date("2026-09-01T12:00:00Z");
    expect(cryptoCompletedCandles(candles, now)).toHaveLength(0);
  });
});

describe("assertNotCryptoFamily", () => {
  it("throws for crypto", () => {
    expect(() => assertNotCryptoFamily("crypto", "testCaller")).toThrow(
      'testCaller: family="crypto" must use cryptoCompletedCandles()',
    );
  });

  it("does not throw for equity families", () => {
    expect(() => assertNotCryptoFamily("operating_company", "testCaller")).not.toThrow();
    expect(() => assertNotCryptoFamily(undefined, "testCaller")).not.toThrow();
  });
});

// Acceptance criterion: routing a crypto row through America/New_York session logic
// must fail the detector. This is the mutation test the architecture requires.
describe("completedSessionCandles — crypto guard", () => {
  const candles = [{ date: "2026-09-04", open: 1, high: 1, low: 1, close: 1, volume: 1 }];

  it("throws when instrumentFamily='crypto' is passed", () => {
    expect(() =>
      completedSessionCandles(candles, "us", new Date("2026-09-04T20:00:00Z"), "crypto"),
    ).toThrow("family=\"crypto\" must use cryptoCompletedCandles()");
  });

  it("does not throw when no family passed (existing callers unaffected)", () => {
    expect(() =>
      completedSessionCandles(candles, "us", new Date("2026-09-04T20:00:00Z")),
    ).not.toThrow();
  });
});
