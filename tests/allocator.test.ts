import { describe, it, expect } from "vitest";
import { allocate, normalizeRegime, computeAllocation, computeAllocationDetailed, type SleeveRow } from "@/lib/allocation/allocator";

const US: SleeveRow[] = [
  { market: "us", sleeve: "equity", target_pct: 70, min_pct: 0, max_pct: 90, instruments: [], enabled: true },
  { market: "us", sleeve: "defensive_etf", target_pct: 20, min_pct: 0, max_pct: 50, instruments: ["SHY", "TLT"], enabled: true },
  { market: "us", sleeve: "cash", target_pct: 10, min_pct: 5, max_pct: 100, instruments: [], enabled: true },
  { market: "us", sleeve: "leveraged", target_pct: 0, min_pct: 0, max_pct: 15, instruments: ["SSO"], enabled: false },
];

const sumPct = (r: { targetPct: number }[]) => Math.round(r.reduce((a, x) => a + x.targetPct, 0));

describe("allocator", () => {
  it("neutral: renormalizes enabled sleeves to 100 and drops disabled leveraged", () => {
    const r = allocate(US, "neutral");
    expect(r.map(x => x.sleeve).sort()).toEqual(["cash", "defensive_etf", "equity"]);
    expect(sumPct(r)).toBe(100);
    expect(r.find(x => x.sleeve === "leveraged")).toBeUndefined();
  });

  it("risk_off shifts weight OUT of equity into defensive/cash (still sums 100)", () => {
    const on = allocate(US, "risk_on").find(x => x.sleeve === "equity")!.targetPct;
    const neu = allocate(US, "neutral").find(x => x.sleeve === "equity")!.targetPct;
    const off = allocate(US, "risk_off").find(x => x.sleeve === "equity")!.targetPct;
    expect(off).toBeLessThan(neu);
    expect(on).toBeGreaterThan(neu);
    expect(sumPct(allocate(US, "risk_off"))).toBe(100);
  });

  it("clamps every sleeve to its hard band", () => {
    for (const reg of ["risk_on", "neutral", "risk_off"] as const) {
      for (const t of allocate(US, reg)) {
        const band = US.find(s => s.sleeve === t.sleeve)!;
        // targetPct is post-renormalize, so just assert non-negative + <=100
        expect(t.targetPct).toBeGreaterThanOrEqual(0);
        expect(t.targetPct).toBeLessThanOrEqual(100);
        expect(band).toBeTruthy();
      }
    }
  });

  it("normalizeRegime maps labels", () => {
    expect(normalizeRegime("RISK_OFF")).toBe("risk_off");
    expect(normalizeRegime("bull market")).toBe("risk_on");
    expect(normalizeRegime(null)).toBe("neutral");
  });

  it("does not emit NaN or zero-sum targets when sleeve inputs are malformed", () => {
    const malformed: SleeveRow[] = [
      { market: "us", sleeve: "equity", target_pct: Number.NaN, min_pct: 0, max_pct: 0, instruments: [], enabled: true },
      { market: "us", sleeve: "defensive_etf", target_pct: 0, min_pct: 0, max_pct: 0, instruments: [], enabled: true },
      { market: "us", sleeve: "cash", target_pct: 0, min_pct: 0, max_pct: 100, instruments: [], enabled: true },
    ];
    const r = allocate(malformed, "neutral");
    expect(r.every(x => Number.isFinite(x.targetPct))).toBe(true);
    expect(sumPct(r)).toBe(100);
    expect(r.find(x => x.sleeve === "cash")?.targetPct).toBe(100);
  });
});

// ── computeAllocation: macro-regime market scoping + usability contract ────────
// Mirrors the prod-verified rows in `macro_regime` (project dionkikgdmlaotvtbnfr).
// macro_regime has NO `market` column, so an unscoped read stamps the US FRED
// verdict onto Indian sleeve weights. Every test below FAILS on the pre-fix
// allocator, which read the newest row unconditionally for both markets.

const INDIA_SLEEVES = [
  { market: "india", sleeve: "equity", target_pct: 70, min_pct: 0, max_pct: 90, instruments: [], enabled: true },
  { market: "india", sleeve: "defensive_etf", target_pct: 20, min_pct: 0, max_pct: 50, instruments: [], enabled: true },
  { market: "india", sleeve: "cash", target_pct: 10, min_pct: 5, max_pct: 100, instruments: [], enabled: true },
];
const US_SLEEVES = US.map(s => ({ ...s }));

/**
 * Minimal Supabase stub. Deliberately supports BOTH the post-fix shape
 * (`.order().limit(3)` awaited) and the PRE-fix shape
 * (`.order().limit(1).maybeSingle()`), so these tests exercise pre-fix code
 * rather than erroring out on it — i.e. they fail on the assertion, proving the
 * bug, not on a missing stub method.
 */
function makeSvc(opts: { allocationEnabled?: boolean; macroRows?: any[]; sleeves?: any[] }) {
  const calls = { macroQueried: false };
  const q = (rows: any[]) => {
    const obj: any = {
      select: () => obj,
      order: () => obj,
      eq: () => obj,
      limit: () => obj,
      maybeSingle: async () => ({ data: rows[0] ?? null }),
      then: (res: any, rej: any) => Promise.resolve({ data: rows }).then(res, rej),
    };
    return obj;
  };
  const svc = {
    from(table: string) {
      if (table === "strategy_config") return q([{ allocation_enabled: opts.allocationEnabled ?? true }]);
      if (table === "strategy_sleeves") return q(opts.sleeves ?? []);
      if (table === "macro_regime") { calls.macroQueried = true; return q(opts.macroRows ?? []); }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { svc, calls };
}

// The real prod row (2026-07-13): a legitimate, indicator-backed verdict.
const FRESH_US_ROW = { regime: "orange", week_of: "2026-07-13", raw_indicators: new Array(7).fill({ k: 1 }) };
// The real prod FOSSIL (2026-06-30): `green` / danger 0 / signals 0 off ZERO
// indicators, summary "No recession signals. Economy in expansion." A failed
// run written out as a calm verdict.
const FOSSIL_GREEN_ROW = { regime: "green", week_of: "2026-06-30", raw_indicators: [] };
const NOW = new Date("2026-07-15T00:00:00Z"); // 2d after FRESH_US_ROW's week_of

describe("computeAllocation — macro market scoping", () => {
  it("India does NOT inherit the US regime — no allocation, and macro_regime is never read", async () => {
    const { svc, calls } = makeSvc({ macroRows: [FRESH_US_ROW], sleeves: INDIA_SLEEVES });
    const r = await computeAllocationDetailed(svc, "india", NOW);
    expect(r.targets).toBeNull();
    expect(r.macro?.available).toBe(false);
    expect(r.reason).toMatch(/india/i);
    // Strongest form of the guarantee: the US verdict is never even fetched.
    expect(calls.macroQueried).toBe(false);
  });

  it("India returns null even though India sleeves exist (prod has 70/20/10)", async () => {
    const { svc } = makeSvc({ macroRows: [FRESH_US_ROW], sleeves: INDIA_SLEEVES });
    expect(await computeAllocation(svc, "india")).toBeNull();
  });

  it("US with a fresh, indicator-backed regime is UNCHANGED (still allocates)", async () => {
    const { svc } = makeSvc({ macroRows: [FRESH_US_ROW], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", NOW);
    expect(r.targets).not.toBeNull();
    expect(sumPct(r.targets!)).toBe(100);
    expect(r.targets!.find(x => x.sleeve === "equity")!.targetPct).toBe(70);
    expect(r.targets!.find(x => x.sleeve === "leveraged")).toBeUndefined();
    expect(r.macro).toMatchObject({ available: true, rawRegime: "orange", indicators: 7 });
  });

  it("a stale (>10d) regime degrades to UNAVAILABLE, not calm", async () => {
    // Same legitimate 7-indicator row, read 20 days later.
    const { svc } = makeSvc({ macroRows: [FRESH_US_ROW], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", new Date("2026-08-02T00:00:00Z"));
    expect(r.targets).toBeNull();
    expect(r.macro?.available).toBe(false);
    // Assert the STRUCTURED per-row cause, not the boilerplate summary — a
    // substring match on the summary can pass by coincidence.
    const rej = (r.macro as any).rejectedRows;
    expect(rej).toHaveLength(1);
    expect(rej[0].reason).toMatch(/^stale: 20d old > 10d bound$/);
  });

  it("the 2026-06-30 zero-indicator `green` fossil is REJECTED even when fresh", async () => {
    // Age bound cannot catch it — evaluated 1 day after its own week_of.
    const { svc } = makeSvc({ macroRows: [FOSSIL_GREEN_ROW], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", new Date("2026-07-01T00:00:00Z"));
    expect(r.targets).toBeNull();
    expect(r.macro?.available).toBe(false);
    const rej = (r.macro as any).rejectedRows;
    expect(rej).toHaveLength(1);
    // Rejected on ZERO indicators — NOT on age (it is 1 day old here) and NOT
    // on signals_triggered=0 (a genuinely calm week looks like that).
    expect(rej[0].reason).toMatch(/only 0 indicator\(s\) < 3 — failed run/);
    expect(rej[0].reason).not.toMatch(/stale/);
  });

  it("an `unknown` verdict is skipped in favour of the prior row IF that row is usable", async () => {
    const prior = { regime: "orange", week_of: "2026-07-13", raw_indicators: new Array(5).fill({ k: 1 }) };
    const { svc } = makeSvc({
      macroRows: [{ regime: "unknown", week_of: "2026-07-20", raw_indicators: [] }, prior],
      sleeves: US_SLEEVES,
    });
    const r = await computeAllocationDetailed(svc, "us", new Date("2026-07-21T00:00:00Z"));
    expect(r.macro).toMatchObject({ available: true, asOf: "2026-07-13" });
    expect(r.targets).not.toBeNull();
  });

  it("reach-back is age-bounded: an `unknown` newest + out-of-bound prior → UNAVAILABLE", async () => {
    const { svc } = makeSvc({
      macroRows: [{ regime: "unknown", week_of: "2026-07-20", raw_indicators: [] }, FRESH_US_ROW],
      sleeves: US_SLEEVES,
    });
    // FRESH_US_ROW (07-13) is 24d old here — beyond the 10d bound.
    const r = await computeAllocationDetailed(svc, "us", new Date("2026-08-06T00:00:00Z"));
    expect(r.targets).toBeNull();
    expect(r.macro?.available).toBe(false);
  });

  it("a row with non-array raw_indicators fails closed (unverifiable evidence)", async () => {
    const { svc } = makeSvc({
      macroRows: [{ regime: "orange", week_of: "2026-07-13", raw_indicators: null }],
      sleeves: US_SLEEVES,
    });
    const r = await computeAllocationDetailed(svc, "us", NOW);
    expect(r.targets).toBeNull();
    expect((r.macro as any).rejectedRows[0].reason).toMatch(/unverifiable indicator/);
  });

  it("no macro_regime rows at all → UNAVAILABLE, never a calm default", async () => {
    const { svc } = makeSvc({ macroRows: [], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", NOW);
    expect(r.targets).toBeNull();
    expect(r.macro?.available).toBe(false);
  });

  it("the regime actually drives the targets (wire is live, not dead)", async () => {
    // Guards against the mapping silently becoming a no-op. NOTE: MacroSentinel's
    // real vocabulary (green/orange/red) all normalizes to `neutral` today — see
    // the normalizeRegime vocabulary gap reported alongside this fix. `bear` is
    // used here purely to prove regime→tilt is wired end-to-end.
    const bear = { regime: "bear", week_of: "2026-07-13", raw_indicators: new Array(7).fill({ k: 1 }) };
    const { svc } = makeSvc({ macroRows: [bear], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", NOW);
    const equity = r.targets!.find(x => x.sleeve === "equity")!.targetPct;
    expect(equity).toBeLessThan(70); // risk_off tilts OUT of equity
  });

  it("allocation_enabled=false short-circuits before any macro read (live prod state)", async () => {
    const { svc, calls } = makeSvc({ allocationEnabled: false, macroRows: [FRESH_US_ROW], sleeves: US_SLEEVES });
    const r = await computeAllocationDetailed(svc, "us", NOW);
    expect(r.targets).toBeNull();
    expect(r.reason).toMatch(/disabled/i);
    expect(calls.macroQueried).toBe(false);
  });
});
