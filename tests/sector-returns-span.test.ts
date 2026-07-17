import { describe, it, expect } from "vitest";
import {
  evaluateWindow,
  computeSectorReturns,
  summariseCoverage,
  cutoffFor,
  daysBetween,
  START_GRACE_DAYS,
  type Candle,
} from "@/lib/markets/sector-returns";

// Anchor every case to a fixed "today" so the suite is deterministic.
const TODAY = "2026-07-16";

const SECTORS = [
  { symbol: "XLK", name: "Technology" },
  { symbol: "XLF", name: "Financials" },
];

const PERIODS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

/** Daily bars every calendar day back from `to`, close drifting by `step`/day. */
function series(to: string, count: number, start: number, step: number): Candle[] {
  const out: Candle[] = [];
  const d = new Date(`${to}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (count - 1));
  for (let i = 0; i < count; i++) {
    out.push({ date: d.toISOString().slice(0, 10), close: start + i * step });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** The exact prod state that produced the bug: two adjacent sessions, nothing else. */
const TWO_BARS: Candle[] = [
  { date: "2026-07-14", close: 100 },
  { date: "2026-07-15", close: 102 },
];

describe("sector returns — span-aware honesty guard", () => {
  // THE REGRESSION. The old guard was `candles.length < 2`, which two bars pass,
  // so every window returned the same +2% one-day move — rendered as "1Y return".
  it("does NOT report a 1Y return from two adjacent daily bars", () => {
    const r = evaluateWindow(TWO_BARS, { days: 365, today: TODAY });
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("insufficient_history");
  });

  it("reports null for EVERY window when only two adjacent bars exist", () => {
    for (const p of PERIODS) {
      const r = evaluateWindow(TWO_BARS, { days: p.days, today: TODAY });
      expect(r.returnPct, `${p.label} must not report a return from a 1-day span`).toBeNull();
      expect(r.reason).not.toBeNull();
    }
  });

  it("never lets a 2-bar cache produce the same number across periods", () => {
    const values = PERIODS.map((p) => evaluateWindow(TWO_BARS, { days: p.days, today: TODAY }).returnPct);
    // Pre-fix this was [2,2,2,2,2]. Post-fix every entry is null (no assertion).
    expect(values.every((v) => v === null)).toBe(true);
  });

  // With genuine history, each window must yield a REAL and DIFFERENT return.
  it("yields a real, distinct return per period when history spans the window", () => {
    const full = series(TODAY, 400, 100, 0.5); // 400 daily bars, monotonically rising
    const returns = PERIODS.map((p) => {
      const windowed = full.filter((c) => c.date >= cutoffFor(TODAY, p.days));
      const r = evaluateWindow(windowed, { days: p.days, today: TODAY });
      expect(r.returnPct, `${p.label} should report a return`).not.toBeNull();
      expect(r.reason).toBeNull();
      return r.returnPct!;
    });

    // All distinct — the core symptom was every period returning an identical value.
    expect(new Set(returns.map((v) => v.toFixed(6))).size).toBe(PERIODS.length);
    // Rising series → a longer lookback must show a larger gain.
    for (let i = 1; i < returns.length; i++) {
      expect(returns[i]).toBeGreaterThan(returns[i - 1]);
    }
  });

  it("computes the return from the window's own endpoints", () => {
    const candles: Candle[] = [
      { date: cutoffFor(TODAY, 30), close: 200 },
      { date: "2026-07-01", close: 150 },
      { date: "2026-07-15", close: 250 },
    ];
    const r = evaluateWindow(candles, { days: 30, today: TODAY });
    expect(r.returnPct).toBeCloseTo(25, 6); // 200 -> 250
    expect(r.oldestDate).toBe(cutoffFor(TODAY, 30));
    expect(r.latestDate).toBe("2026-07-15");
  });
});

describe("sector returns — span coverage floor", () => {
  // OBSERVED PROD REGRESSION (2026-07-17). The start-edge grace alone let this
  // through: cutoff 07-10, oldest bar 07-14 is exactly START_GRACE_DAYS later,
  // newest bar 2 days stale — both edge checks passed and a 1-day move was
  // served as a "1W return" of -1.11%. The span floor is what rejects it.
  it("does NOT report a 1W return when two bars span a single day", () => {
    const r = evaluateWindow(TWO_BARS, { days: 7, today: "2026-07-17" });
    expect(r.spanDays).toBe(1);
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("insufficient_history");
    expect(r.reason?.message).toContain("span only 1 day");
  });

  it("rejects the 2-bar cache on every period at the date that defeated the edge check", () => {
    for (const p of PERIODS) {
      const r = evaluateWindow(TWO_BARS, { days: p.days, today: "2026-07-17" });
      expect(r.returnPct, `${p.label} must not report a 1-day span`).toBeNull();
    }
  });

  // The floor must not false-reject a genuinely short trading week.
  it("accepts a holiday-shortened 1W (Tue→Fri span of 3 days)", () => {
    // today = Mon 2026-07-20; prior Mon 07-13 a holiday, so bars run Tue→Fri.
    const r = evaluateWindow(
      [
        { date: "2026-07-14", close: 100 },
        { date: "2026-07-15", close: 101 },
        { date: "2026-07-16", close: 102 },
        { date: "2026-07-17", close: 103 },
      ],
      { days: 7, today: "2026-07-20" },
    );
    expect(r.spanDays).toBe(3);
    expect(r.returnPct).toBeCloseTo(3, 6);
    expect(r.reason).toBeNull();
  });

  it("accepts a normal full 1W trading week", () => {
    const r = evaluateWindow(
      [
        { date: "2026-07-13", close: 100 },
        { date: "2026-07-17", close: 104 },
      ],
      { days: 7, today: "2026-07-20" },
    );
    expect(r.spanDays).toBe(4);
    expect(r.returnPct).toBeCloseTo(4, 6);
    expect(r.reason).toBeNull();
  });
});

describe("sector returns — start-edge tolerance", () => {
  // Exact-match would be wrong: weekends and holidays mean the first session
  // routinely lands a few days after the cutoff.
  it("accepts an oldest bar within the grace window of the cutoff", () => {
    const cutoff = cutoffFor(TODAY, 90);
    const oldest = new Date(`${cutoff}T00:00:00Z`);
    oldest.setUTCDate(oldest.getUTCDate() + START_GRACE_DAYS); // holiday-extended weekend
    const r = evaluateWindow(
      [
        { date: oldest.toISOString().slice(0, 10), close: 100 },
        { date: "2026-07-15", close: 110 },
      ],
      { days: 90, today: TODAY },
    );
    expect(r.returnPct).toBeCloseTo(10, 6);
    expect(r.reason).toBeNull();
  });

  it("rejects an oldest bar one day beyond the grace window", () => {
    const cutoff = cutoffFor(TODAY, 90);
    const oldest = new Date(`${cutoff}T00:00:00Z`);
    oldest.setUTCDate(oldest.getUTCDate() + START_GRACE_DAYS + 1);
    const r = evaluateWindow(
      [
        { date: oldest.toISOString().slice(0, 10), close: 100 },
        { date: "2026-07-15", close: 110 },
      ],
      { days: 90, today: TODAY },
    );
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("insufficient_history");
  });
});

describe("sector returns — end-edge staleness", () => {
  it("refuses a window whose newest bar is far in the past", () => {
    // Spans a full year but ends 40 days ago — not a "1Y-to-today" return.
    const stale = series("2026-06-06", 400, 100, 0.5).filter(
      (c) => c.date >= cutoffFor(TODAY, 365),
    );
    const r = evaluateWindow(stale, { days: 365, today: TODAY });
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("stale_cache");
  });
});

describe("sector returns — degenerate inputs", () => {
  it("reports no_data for an empty series", () => {
    const r = evaluateWindow([], { days: 365, today: TODAY });
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("no_data");
    expect(r.candles).toBe(0);
  });

  it("reports single_bar for a one-bar series", () => {
    const r = evaluateWindow([{ date: "2026-07-15", close: 100 }], { days: 7, today: TODAY });
    expect(r.returnPct).toBeNull();
    expect(r.reason?.code).toBe("single_bar");
  });
});

describe("sector returns — honest messaging (what / why / next)", () => {
  it("names the period, the cutoff and the actual oldest bar", () => {
    const r = evaluateWindow(TWO_BARS, { days: 365, today: TODAY });
    const msg = r.reason!.message;
    expect(msg).toContain("1Y");
    expect(msg).toContain("2026-07-14"); // the real oldest bar (why)
    expect(msg).toContain(cutoffFor(TODAY, 365)); // where the window starts (what)
    expect(msg.toLowerCase()).toContain("shorter period"); // next
    // Must never be a bare status string.
    expect(msg.length).toBeGreaterThan(60);
  });

  it("surfaces an insufficient-history note the UI can render verbatim", () => {
    const rows = computeSectorReturns(
      SECTORS,
      { XLK: TWO_BARS, XLF: TWO_BARS },
      { days: 365, today: TODAY },
    );
    const cov = summariseCoverage(rows);
    expect(cov.withReturn).toBe(0);
    expect(cov.total).toBe(2);
    expect(cov.note).toBeTruthy();
    expect(cov.note).toContain("No sector can report this window");
  });

  it("reports no note when every sector has real history", () => {
    const full = series(TODAY, 400, 100, 0.5).filter((c) => c.date >= cutoffFor(TODAY, 365));
    const rows = computeSectorReturns(SECTORS, { XLK: full, XLF: full }, { days: 365, today: TODAY });
    const cov = summariseCoverage(rows);
    expect(cov.withReturn).toBe(2);
    expect(cov.note).toBeNull();
  });

  it("names the specific sectors that cannot report under partial coverage", () => {
    const full = series(TODAY, 400, 100, 0.5).filter((c) => c.date >= cutoffFor(TODAY, 365));
    const rows = computeSectorReturns(SECTORS, { XLK: full, XLF: TWO_BARS }, { days: 365, today: TODAY });
    const cov = summariseCoverage(rows);
    expect(cov.withReturn).toBe(1);
    expect(cov.note).toContain("XLF");
    expect(rows.find((r) => r.symbol === "XLK")!.returnPct).not.toBeNull();
    expect(rows.find((r) => r.symbol === "XLF")!.returnPct).toBeNull();
  });
});

describe("sector returns — date helpers", () => {
  it("daysBetween counts whole calendar days", () => {
    expect(daysBetween("2026-07-14", "2026-07-15")).toBe(1);
    expect(daysBetween("2026-07-15", "2026-07-15")).toBe(0);
    expect(daysBetween("2025-07-16", "2026-07-16")).toBe(365);
  });

  it("cutoffFor subtracts calendar days", () => {
    expect(cutoffFor("2026-07-16", 7)).toBe("2026-07-09");
    expect(cutoffFor("2026-07-16", 365)).toBe("2025-07-16");
  });
});
