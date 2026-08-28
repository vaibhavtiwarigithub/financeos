import { describe, it, expect } from "vitest";
import {
  planBenchmarkConfirmations,
  BENCHMARK_CROSSCHECK_TOLERANCE_PCT,
} from "./benchmark-observation";

const settled = new Map<string, number>([
  ["2026-08-19", 24078.30],
  ["2026-08-20", 24231.85],
  ["2026-08-25", 24334.55],
  ["2026-08-26", 24207.75],
]);

function row(date: string, bench_nav: number | null, bench_source: string | null) {
  return { date, bench_nav, bench_source };
}

describe("planBenchmarkConfirmations", () => {
  it("confirms a provisional row whose settled close agrees", () => {
    // 24078.30 vs 24076.75 is 0.006% apart — inside the 0.05% tolerance.
    const [c] = planBenchmarkConfirmations([row("2026-08-19", 24076.75, "yahoo(unconfirmed)")], settled);
    expect(c.source).toBe("upstox+yahoo");
    expect(c.settledClose).toBe(24078.30);
    expect(c.deltaPct).toBeLessThan(BENCHMARK_CROSSCHECK_TOLERANCE_PCT);
  });

  it("records disagreement explicitly instead of hiding it", () => {
    // 24334.55 vs 24172.30 is 0.67% apart — well outside tolerance.
    const [c] = planBenchmarkConfirmations([row("2026-08-25", 24172.30, "yahoo(unconfirmed)")], settled);
    expect(c.source).toBe("upstox(yahoo_disagreed)");
    expect(c.settledClose).toBe(24334.55);
    expect(c.deltaPct).toBeGreaterThan(0.5);
  });

  // The load-bearing exclusion. A row that already carries exchange provenance
  // is final; re-confirming it would let a later run overwrite a settled value.
  it("never touches an already-confirmed row", () => {
    expect(planBenchmarkConfirmations([
      row("2026-08-19", 24076.75, "upstox+yahoo"),
      row("2026-08-20", 24202.75, "upstox"),
      row("2026-08-25", 24172.30, "upstox(yahoo_disagreed)"),
      row("2026-08-26", 24358.95, "upstox(unconfirmed)"),
    ], settled)).toEqual([]);
  });

  // Any provisional YAHOO label is eligible, not only "yahoo(unconfirmed)".
  // Requiring the literal word "unconfirmed" would strand this row forever.
  it("confirms a yahoo_quote(provisional) row too", () => {
    const [c] = planBenchmarkConfirmations([row("2026-08-20", 24202.75, "yahoo_quote(provisional)")], settled);
    expect(c).toBeDefined();
    expect(c.settledClose).toBe(24231.85);
    expect(c.source).toBe("upstox(yahoo_disagreed)");
  });

  it("skips rows with no settled bar yet — today's session is never available", () => {
    expect(planBenchmarkConfirmations([row("2026-08-27", 24201.50, "yahoo(unconfirmed)")], settled)).toEqual([]);
  });

  it("skips rows with an unusable stored value rather than inventing one", () => {
    expect(planBenchmarkConfirmations([
      row("2026-08-19", null, "yahoo(unconfirmed)"),
      row("2026-08-20", 0, "yahoo(unconfirmed)"),
    ], settled)).toEqual([]);
  });

  it("ignores a provisional row from a source that is not the Yahoo primary", () => {
    // 'upstox(unconfirmed)' is already exchange-sourced; confirming it against
    // Upstox would be comparing a source to itself.
    expect(planBenchmarkConfirmations([row("2026-08-19", 24078.30, "upstox(unconfirmed)")], settled)).toEqual([]);
  });

  it("confirms several sessions in one pass", () => {
    const out = planBenchmarkConfirmations([
      row("2026-08-19", 24076.75, "yahoo(unconfirmed)"),
      row("2026-08-25", 24172.30, "yahoo(unconfirmed)"),
      row("2026-08-27", 24201.50, "yahoo(unconfirmed)"),
    ], settled);
    expect(out.map(c => c.date)).toEqual(["2026-08-19", "2026-08-25"]);
  });
});

describe("planBenchmarkConfirmations — US policy", () => {
  const usSettled = new Map<string, number>([
    ["2026-08-19", 706.91], ["2026-08-20", 701.01], ["2026-08-21", 703.71],
    ["2026-08-25", 704.02], ["2026-08-26", 704.20],
  ]);

  // The finding that motivated the US arm: a same-session Yahoo DAILY BAR read
  // at 16:15 ET is an in-progress bar, yet CONFIRMED_BENCHMARK_SOURCES lists
  // "yahoo" as confirmed. Production 08-25 stored 702.74 against a settled
  // 704.02 — 0.18% wrong while labelled confirmed.
  it("treats a plain `yahoo` row as still provisional", () => {
    const [c] = planBenchmarkConfirmations([row("2026-08-25", 702.74, "yahoo")], usSettled, "us");
    expect(c).toBeDefined();
    expect(c.settledClose).toBe(704.02);
    expect(c.source).toBe("yahoo(settled)");
  });

  it("fills a row that never resolved, and reports it as a fill not a disagreement", () => {
    const [c] = planBenchmarkConfirmations([row("2026-08-19", null, null)], usSettled, "us");
    expect(c.storedClose).toBeNull();
    // A fabricated 0% delta would read as two sources agreeing when only one existed.
    expect(c.deltaPct).toBeNull();
    expect(c.settledClose).toBe(706.91);
  });

  it("upgrades a provisional quote row", () => {
    const [c] = planBenchmarkConfirmations([row("2026-08-21", 703.71, "yahoo_quote(provisional)")], usSettled, "us");
    expect(c.source).toBe("yahoo(settled)");
    expect(c.deltaPct).toBeCloseTo(0, 6);
  });

  it("leaves genuinely settled providers alone", () => {
    // Massive's grouped endpoint publishes next-day, so those rows are settled.
    expect(planBenchmarkConfirmations([
      row("2026-08-19", 706.91, "massive"),
      row("2026-08-20", 701.01, "eodhd"),
      row("2026-08-21", 703.71, "yahoo(settled)"),
    ], usSettled, "us")).toEqual([]);
  });

  it("does not let the US fill rule leak into India", () => {
    // India needs a stored Yahoo value: without one there is no second opinion,
    // so "upstox+yahoo" would be a false provenance claim.
    expect(planBenchmarkConfirmations([row("2026-08-19", null, null)], usSettled, "india")).toEqual([]);
  });
});
