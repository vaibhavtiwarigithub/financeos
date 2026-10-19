import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeCorrelationShadow, computeCovarianceSizingShadow, covarianceShrinkage, loadPointInTimeReturnPanel, pearson,
  MAX_SINGLE_PAIR_CORR, MAX_AVG_CORR_TO_BOOK, MIN_SHARED_SESSIONS, MIN_COVARIANCE_SESSIONS,
} from "@/lib/portfolio/correlation-shadow";

/** Deterministic series: y = rho*x + sqrt(1-rho^2)*z, so correlation is known. */
function series(n: number, seed: number, rho = 1, other?: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  for (let i = 0; i < n; i++) {
    const z = rnd();
    const base = other ? other[i] : z;
    const v = other ? rho * base + Math.sqrt(Math.max(0, 1 - rho * rho)) * z : base;
    out[`2026-01-${String((i % 28) + 1).padStart(2, "0")}-${Math.floor(i / 28)}`] = v;
  }
  return out;
}
const vals = (s: Record<string, number>) => Object.values(s);

describe("pearson", () => {
  it("is 1 for an identical series and -1 for its negation", () => {
    const a = [0.01, -0.02, 0.03, 0.00, -0.01, 0.02];
    expect(pearson(a, a)!).toBeCloseTo(1, 6);
    expect(pearson(a, a.map((v) => -v))!).toBeCloseTo(-1, 6);
  });

  it("returns null for a FLAT series rather than claiming independence", () => {
    // Zero variance means undefined correlation. Returning 0 would assert
    // "independent", which is a claim the data does not support.
    expect(pearson([0.01, -0.01, 0.02], [0.5, 0.5, 0.5])).toBeNull();
  });
});

describe("correlation shadow — the EOG/OXY case it exists to catch", () => {
  const n = 60;
  const oxy = series(n, 7);
  const eogVals = vals(oxy).map((v, i) => 0.9 * v + 0.02 * ((i % 5) - 2) * 0.01);
  const eog: Record<string, number> = {};
  Object.keys(oxy).forEach((d, i) => { eog[d] = eogVals[i]; });
  const indep = series(n, 991);

  it("WOULD DENY a candidate that duplicates one held name, even in a large book", () => {
    // The measured 0.845 EOG/OXY pair against a book of nine barely moves the
    // mean — an average-only rule cannot see it. The pair rule must.
    const r = computeCorrelationShadow({
      candidate: "EOG",
      book: ["OXY", "A", "B", "C", "D", "E", "F", "G"],
      returns: {
        EOG: eog, OXY: oxy,
        A: series(n, 1), B: series(n, 2), C: series(n, 3), D: series(n, 4),
        E: series(n, 5), F: series(n, 6), G: series(n, 8),
      },
    });
    expect(r.verdict).toBe("would_deny");
    expect(r.worstPairSymbol).toBe("OXY");
    expect(r.maxCorrToBook!).toBeGreaterThan(MAX_SINGLE_PAIR_CORR);
    expect(r.avgCorrToBook!).toBeLessThan(MAX_AVG_CORR_TO_BOOK); // avg alone would have passed it
    expect(r.reason).toContain("WOULD DENY");
  });

  it("would allow a genuinely independent candidate", () => {
    const r = computeCorrelationShadow({
      candidate: "IND", book: ["OXY"], returns: { IND: indep, OXY: oxy },
    });
    expect(r.verdict).toBe("would_allow");
  });

  it("an EMPTY book is allowed — nothing to be correlated with", () => {
    const r = computeCorrelationShadow({ candidate: "IND", book: [], returns: { IND: indep } });
    expect(r.verdict).toBe("unmeasurable");
    expect(r.pairsMeasured).toBe(0);
  });
});

describe("absent history is UNMEASURABLE, never a pass", () => {
  it("refuses a candidate with no captured returns — the live SKHY case", () => {
    // SKHY sits in the US book with ZERO return days. A gate that treats missing
    // data as uncorrelated would wave through exactly the names it cannot see.
    const r = computeCorrelationShadow({
      candidate: "SKHY", book: ["OXY"], returns: { OXY: series(40, 3) },
    });
    expect(r.verdict).toBe("unmeasurable");
    expect(r.verdict).not.toBe("would_allow");
    expect(r.reason).toContain("NOT assumed independent");
  });

  it("skips held names with too little overlap instead of correlating on noise", () => {
    const short: Record<string, number> = {};
    Object.entries(series(MIN_SHARED_SESSIONS - 5, 11)).forEach(([k, v]) => { short[k] = v; });
    const r = computeCorrelationShadow({
      candidate: "X", book: ["SHORTY"], returns: { X: series(60, 12), SHORTY: short },
    });
    expect(r.skipped).toContain("SHORTY");
    expect(r.verdict).toBe("unmeasurable");
  });
});

describe("point-in-time covariance sizing shadow", () => {
  const dates = Array.from({ length: MIN_COVARIANCE_SESSIONS }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}`);
  const common = Object.fromEntries(dates.map((date, i) => [date, i % 2 === 0 ? 0.02 : -0.02]));

  it("uses deterministic diagonal shrinkage that increases with dimension and decreases with sample size", () => {
    const first = covarianceShrinkage(60, 10);
    const repeated = covarianceShrinkage(60, 10);
    expect(repeated).toBe(first);
    expect(covarianceShrinkage(60, 10)).toBeGreaterThan(covarianceShrinkage(120, 10));
    expect(covarianceShrinkage(60, 20)).toBeGreaterThan(covarianceShrinkage(60, 10));
  });

  it("shrinks but never increases the constructor size when measured portfolio risk exceeds budget", () => {
    const result = computeCovarianceSizingShadow({
      candidate: "NEW",
      book: [{ symbol: "HELD", valuePct: 50 }],
      returns: { HELD: common, NEW: common },
      priceBasis: "adjusted_close",
      commonSessions: dates,
      baselineSizePct: 20,
      maxPortfolioDailyVolPct: 1.15,
    });
    expect(result.state).toBe("measured");
    expect(result.counterfactualSizePct).toBeLessThan(20);
    expect(result.counterfactualSizePct).toBeGreaterThanOrEqual(0);
    expect(result.counterfactualDailyVolPct).toBeLessThanOrEqual(1.15 + 1e-6);
    expect(result.sizeReductionPct).toBeCloseTo(20 - result.counterfactualSizePct!, 4);
  });

  it("preserves the baseline when risk is already within budget", () => {
    const result = computeCovarianceSizingShadow({
      candidate: "NEW", book: [{ symbol: "HELD", valuePct: 5 }],
      returns: { HELD: common, NEW: common }, priceBasis: "raw_close", commonSessions: dates,
      baselineSizePct: 5, maxPortfolioDailyVolPct: 2,
    });
    expect(result.state).toBe("measured");
    expect(result.counterfactualSizePct).toBe(5);
    expect(result.sizeReductionPct).toBe(0);
  });

  it("does not treat insufficient history or a missing common price basis as safe risk", () => {
    const thinDates = dates.slice(0, MIN_COVARIANCE_SESSIONS - 1);
    const thin = Object.fromEntries(thinDates.map((date) => [date, 0.01]));
    expect(computeCovarianceSizingShadow({
      candidate: "NEW", book: [], returns: { NEW: thin }, priceBasis: "adjusted_close",
      commonSessions: thinDates, baselineSizePct: 10, maxPortfolioDailyVolPct: 2,
    })).toMatchObject({ state: "unmeasurable", counterfactualSizePct: null });
    expect(computeCovarianceSizingShadow({
      candidate: "NEW", book: [], returns: { NEW: common }, priceBasis: null,
      commonSessions: dates, baselineSizePct: 10, maxPortfolioDailyVolPct: 2,
    })).toMatchObject({ state: "unmeasurable", reason: "no_common_price_basis", counterfactualSizePct: null });
  });

  it("keeps an already over-budget book from being represented as fixed by the candidate", () => {
    const result = computeCovarianceSizingShadow({
      candidate: "NEW", book: [{ symbol: "HELD", valuePct: 80 }],
      returns: { HELD: common, NEW: common }, priceBasis: "adjusted_close", commonSessions: dates,
      baselineSizePct: 10, maxPortfolioDailyVolPct: 1,
    });
    expect(result.state).toBe("measured");
    expect(result.counterfactualSizePct).toBe(0);
    expect(result.counterfactualDailyVolPct).toBeGreaterThan(1);
  });

  it("loads only rows available by the decision instant and selects one common price basis", async () => {
    const decisionAt = new Date("2026-10-18T18:00:00.000Z");
    const rows: any[] = [];
    for (let i = 0; i < MIN_COVARIANCE_SESSIONS; i++) {
      const date = `2026-01-${String(i + 1).padStart(2, "0")}`;
      rows.push({ id: i + 1, symbol: "A", session_date: date, simple_return: 0.01, available_at: "2026-10-18T17:00:00.000Z", price_basis: "adjusted_close", input_fingerprint: `a${i}` });
      rows.push({ id: MIN_COVARIANCE_SESSIONS + i + 1, symbol: "B", session_date: date, simple_return: -0.01, available_at: "2026-10-18T17:00:00.000Z", price_basis: "adjusted_close", input_fingerprint: `b${i}` });
    }
    rows.push({ id: 9999, symbol: "A", session_date: "2026-03-01", simple_return: 0.99, available_at: "2026-10-18T19:00:00.000Z", price_basis: "adjusted_close", input_fingerprint: "future" });
    rows.push({ id: 10000, symbol: "A", session_date: dates[0], simple_return: 0.02, available_at: "2026-10-18T17:30:00.000Z", price_basis: "adjusted_close", input_fingerprint: "revision" });

    let cutoff = "";
    const builder: any = {
      select() { return this; }, eq() { return this; }, in() { return this; }, gte() { return this; }, not() { return this; },
      lte(_column: string, value: string) { cutoff = value; return this; },
      order() { return this; }, limit() { return this; },
      then(resolve: (value: any) => unknown, reject: (reason: unknown) => unknown) {
        const filtered = rows.filter((row) => row.available_at <= cutoff)
          .sort((a, b) => b.available_at.localeCompare(a.available_at) || b.id - a.id);
        return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
      },
    };
    const panel = await loadPointInTimeReturnPanel({ from: () => builder }, "us", ["A", "B"], decisionAt);
    expect(cutoff).toBe(decisionAt.toISOString());
    expect(panel.priceBasis).toBe("adjusted_close");
    expect(panel.commonSessions).toHaveLength(MIN_COVARIANCE_SESSIONS);
    expect(panel.returns.A[dates[0]]).toBe(0.02);
    expect(panel.returns.A["2026-03-01"]).toBeUndefined();
    expect(panel.evidenceFingerprint).toMatch(/^fnv1a-/);
  });
});

describe("BOUNDARY: the shadow may not reach the money path", () => {
  const strip = (p: string) => readFileSync(p, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("the constructor does not import the shadow", () => {
    expect(strip("lib/portfolio/constructor.ts")).not.toContain("correlation-shadow");
  });

  it("paper-trade uses it ONLY for a log, never to gate a fill", () => {
    const route = strip("app/api/agents/paper-trade/route.ts");
    expect(route).toContain("correlation-shadow");

    // Assert on the REGION, not on a variable name. An earlier version of this
    // test matched the identifier `correlationShadow`, which the wiring never
    // used — so it passed against a deliberate mutation that DID gate a fill.
    // A boundary test that cannot fail is worse than no boundary test.
    const start = route.indexOf("computeCorrelationShadow({");
    const end = route.indexOf("const constructed = constructPortfolio(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const region = route.slice(start, end);
    for (const forbidden of ["continue", "skipped.push", "revertClaim", "return "]) {
      expect(region).not.toContain(forbidden);
    }

    const covarianceStart = route.indexOf("computeCovarianceSizingShadow({");
    const covarianceEnd = route.indexOf("const noRoom", covarianceStart);
    expect(covarianceStart).toBeGreaterThan(-1);
    expect(covarianceEnd).toBeGreaterThan(covarianceStart);
    const covarianceRegion = route.slice(covarianceStart, covarianceEnd);
    expect(covarianceRegion).toContain('stage: "covariance_sizing_shadow"');
    expect(covarianceRegion).not.toContain("continue");
    expect(route).not.toContain("riskShadow.counterfactualSizePct");
  });
});
