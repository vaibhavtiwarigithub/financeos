import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLAN,
  runDiagnostic,
  selectPointInTimeUniverses,
} from "../scripts/run-local-historical-replay.mjs";
import { spearman } from "../lib/edges/rank-statistics";
import { spearman as productionSpearman } from "../lib/edges/ic";

async function* rows(values: Array<Record<string, unknown>>) {
  for (const value of values) yield value;
}

function sessionDates(count: number, start = "2024-01-01") {
  const first = new Date(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}

describe("local historical replay", () => {
  it("shares tie-safe Spearman semantics with the production IC path", () => {
    const left = [10, 10, 20, 30, 30, 40];
    const right = [1, 2, 2, 4, 5, 6];
    expect(spearman(left, right)).toBe(productionSpearman(left, right));
  });

  it("selects each universe from trailing turnover available on that date", async () => {
    const input: Array<Record<string, unknown>> = [];
    for (let day = 1; day <= 24; day++) {
      const date = `2024-01-${String(day).padStart(2, "0")}`;
      input.push(
        { session_date: date, symbol: "AAA", close: 100, volume: 100, turnover: 1_000 + day },
        { session_date: date, symbol: "BBB", close: 100, volume: 100, turnover: 2_000 + day },
        { session_date: date, symbol: "GOLDBEES", close: 100, volume: 100, turnover: 9_000 + day },
      );
    }
    const selected = await selectPointInTimeUniverses(rows(input), {
      ...DEFAULT_PLAN,
      dateFrom: "2024-01-20",
      dateThrough: "2024-01-24",
      dataCutoff: "2024-01-24",
      liquidityLookbackSessions: 3,
      stepSessions: 1,
      universeSize: 2,
      minimumPriceInr: 20,
    });
    expect(selected.universes.get("2024-01-20")).toEqual(["BBB", "AAA"]);
    expect([...selected.universes.values()].flat()).not.toContain("GOLDBEES");
  });

  it("uses only the declared history and fully matured forward label", () => {
    const plan = {
      ...DEFAULT_PLAN,
      historySessions: 60,
      horizonSessions: 2,
      minimumCrossSection: 3,
      foldCount: 2,
    };
    const symbols = ["AAA", "BBB", "CCC", "DDD"];
    const dates = sessionDates(70, "2024-02-01");
    const series = new Map(
      symbols.map((symbol, symbolIndex) => [
        symbol,
        dates.map((date, index) => {
          const trend = (symbolIndex - 1.5) * 0.002;
          const close = 100 * (1 + trend * index);
          return { date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1000 + symbolIndex * 100 };
        }),
      ]),
    );
    const asOf = dates[64];
    const result = runDiagnostic({
      plan,
      universes: new Map([[asOf, symbols]]),
      series,
      actions: new Map(),
    });
    expect(result.perDate).toHaveLength(1);
    expect(result.perDate[0].crossSection).toBe(4);
    expect(result.perDate[0].date).toBe(asOf);
  });

  it("excludes a price-affecting action inside the feature-label window", () => {
    const plan = {
      ...DEFAULT_PLAN,
      historySessions: 60,
      horizonSessions: 2,
      minimumCrossSection: 3,
      foldCount: 1,
    };
    const symbols = ["AAA", "BBB", "CCC", "DDD"];
    const dates = sessionDates(70, "2024-05-01");
    const series = new Map(
      symbols.map((symbol, symbolIndex) => [
        symbol,
        dates.map((date, index) => {
          const close = 100 * (1 + (symbolIndex - 1.5) * 0.002 * index);
          return { date, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
        }),
      ]),
    );
    const asOf = dates[64];
    const result = runDiagnostic({
      plan,
      universes: new Map([[asOf, symbols]]),
      series,
      actions: new Map([["AAA", [dates[65]]]]),
    });
    expect(result.perDate[0].actionExcluded).toBe(1);
    expect(result.perDate[0].crossSection).toBe(3);
  });
});
