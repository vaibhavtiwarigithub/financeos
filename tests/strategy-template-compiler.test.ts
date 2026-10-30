import { describe, expect, it } from "vitest";
import { compileStrategyTemplate } from "@/lib/strategy-replay/template-compiler";
import { isMissingStrategyLabSchemaObject } from "@/lib/strategy-replay/schema-errors";

const source = (rules: Record<string, unknown>) => ({ id: "11111111-1111-4111-8111-111111111111", name: "Technical Trend", rules });

describe("strict strategy-template compiler", () => {
  it("compiles only an exact, supported daily technical rule set", () => {
    const result = compileStrategyTemplate(source({ rsi_min: 60, above_ma50: true }), {
      market: "us", universe: ["SPY"], horizonSessions: 10,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.entry).toEqual({ op: "and", terms: [
      { op: "cmp2", left: { fn: "close" }, cmp: ">", right: { fn: "sma", period: 50 } },
      { op: "cmp", left: { fn: "rsi_wilder", period: 14 }, cmp: ">=", right: 60 },
    ] });
    expect(result.spec.execution).toBe("next_open");
    expect(result.spec.exit).toEqual({ op: "held_sessions", cmp: ">=", value: 10 });
    expect(result.spec.universe).toEqual(["SPY"]);
    expect(result.ok && result.compilerVersion).toBe("template-rule-compiler-v2");
  });

  it("compiles the existing Trend Follow template without dropping its 52-week-high rule", () => {
    const result = compileStrategyTemplate(source({
      above_ma200: true,
      ma50_above_ma200: true,
      pct_from_52w_high_max: 15,
    }), { market: "us", universe: ["SPY"], horizonSessions: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compilerVersion).toBe("template-rule-compiler-v2");
    expect(result.spec.entry).toEqual({ op: "and", terms: [
      { op: "cmp2", left: { fn: "close" }, cmp: ">", right: { fn: "sma", period: 200 } },
      { op: "cmp2", left: { fn: "sma", period: 50 }, cmp: ">", right: { fn: "sma", period: 200 } },
      { op: "cmp", left: { fn: "pct_below_rolling_high", period: 252 }, cmp: "<=", right: 15 },
    ] });
  });

  it("rejects a malformed 52-week-high threshold", () => {
    const result = compileStrategyTemplate(source({ pct_from_52w_high_max: 101 }), {
      market: "us", universe: ["SPY"], horizonSessions: 10,
    });
    expect(result).toMatchObject({ ok: false, errors: ["pct_from_52w_high_max must be a finite percentage from 0 to 100"] });
  });

  it("refuses unsupported fundamental or sentiment rules instead of silently dropping them", () => {
    const result = compileStrategyTemplate(source({ rsi_min: 60, revenue_accel: true }), {
      market: "us", universe: ["SPY"], horizonSessions: 10,
    });
    expect(result).toMatchObject({ ok: false, errors: ["unsupported template rules: revenue_accel"] });
  });

  it("rejects invalid horizons, duplicate symbols, and cross-market symbols", () => {
    expect(compileStrategyTemplate(source({ above_ma200: true }), { market: "us", universe: ["SPY", "SPY"], horizonSessions: 10 }).ok).toBe(false);
    expect(compileStrategyTemplate(source({ above_ma200: true }), { market: "india", universe: ["SPY"], horizonSessions: 10 }).ok).toBe(false);
    expect(compileStrategyTemplate(source({ above_ma200: true }), { market: "us", universe: ["SPY"], horizonSessions: 0 }).ok).toBe(false);
  });

  it("normalizes India NSE/BSE symbols but does not mix them into US", () => {
    const result = compileStrategyTemplate(source({ above_ma200: true }), {
      market: "india", universe: ["reliance.ns"], horizonSessions: 20,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec.universe).toEqual(["RELIANCE.NS"]);
  });
});

describe("strategy lab schema availability", () => {
  it("classifies Postgres and PostgREST missing table/function errors as deployment blockers", () => {
    for (const code of ["42P01", "42883", "PGRST202", "PGRST205"]) {
      expect(isMissingStrategyLabSchemaObject({ code })).toBe(true);
    }
    expect(isMissingStrategyLabSchemaObject({ code: "42501" })).toBe(false);
    expect(isMissingStrategyLabSchemaObject(null)).toBe(false);
  });
});
