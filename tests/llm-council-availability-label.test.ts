import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { availabilityAlignedLabel } from "@/lib/llm-council/availability-label";

const marks = (closes: Array<[string, number]>) => closes.map(([date, close]) => ({ date, close }));

describe("subscription availability-aligned labels", () => {
  it("starts only at the first complete close strictly after forecast availability", () => {
    const label = availabilityAlignedLabel({
      market: "us", availableAt: "2026-09-28T20:01:00.000Z", horizonDays: 2,
      symbolMarks: marks([["2026-09-28", 100], ["2026-09-29", 102], ["2026-09-30", 101], ["2026-10-01", 104]]),
      benchmarkMarks: marks([["2026-09-28", 500], ["2026-09-29", 505], ["2026-09-30", 502], ["2026-10-01", 510]]),
    });
    expect(label?.entrySession).toBe("2026-09-29");
    expect(label?.endSession).toBe("2026-10-01");
    expect(label?.benchmarkNeutralReturn).toBeCloseTo(104 / 102 - 510 / 505);
  });

  it("uses the same-day close only when that close is still in the future", () => {
    const label = availabilityAlignedLabel({
      market: "india", availableAt: "2026-09-28T08:00:00.000Z", horizonDays: 2,
      symbolMarks: marks([["2026-09-28", 100], ["2026-09-29", 101], ["2026-09-30", 102]]),
      benchmarkMarks: marks([["2026-09-28", 200], ["2026-09-29", 202], ["2026-09-30", 201]]),
    });
    expect(label?.entrySession).toBe("2026-09-28");
    expect(label?.endSession).toBe("2026-09-30");
  });

  it("refuses stale, unmatured, unsupported-calendar, and misaligned windows", () => {
    const base = {
      market: "us" as const, availableAt: "2026-09-28T19:59:00.000Z", horizonDays: 2,
      symbolMarks: marks([["2026-09-29", 100], ["2026-09-30", 101], ["2026-10-01", 102]]),
      benchmarkMarks: marks([["2026-09-29", 500], ["2026-10-01", 510]]),
    };
    expect(availabilityAlignedLabel({ ...base, horizonDays: 20 })).toBeNull();
    expect(availabilityAlignedLabel({ ...base, benchmarkMarks: marks([["2026-09-29", 500], ["2026-09-30", 505]]) })).toBeNull();
    expect(availabilityAlignedLabel({ ...base, availableAt: "2026-10-01T21:00:00.000Z" })).toBeNull();
  });

  it("does not treat a same-day bar as available before that market's close", () => {
    const label = availabilityAlignedLabel({
      market: "us", availableAt: "2026-09-28T19:59:00.000Z", horizonDays: 2,
      symbolMarks: marks([["2026-09-28", 100], ["2026-09-29", 101], ["2026-09-30", 102]]),
      benchmarkMarks: marks([["2026-09-28", 200], ["2026-09-29", 202], ["2026-09-30", 201]]),
    });
    expect(label?.entrySession).toBe("2026-09-28");
  });

  it("rejects an intermediate aligned session with a missing close", () => {
    const dates = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"];
    const label = availabilityAlignedLabel({
      market: "us", availableAt: "2026-09-28T19:59:00.000Z", horizonDays: 2,
      symbolMarks: dates.map((date, index) => ({ date, close: index === 2 ? null : 100 + index })),
      benchmarkMarks: dates.map((date, index) => ({ date, close: 200 + index })),
    });
    expect(label).toBeNull();
  });

  it("keeps hybrid membership/API provenance separate and never broadens the money path", () => {
    const migration = readFileSync("supabase/migrations/20261012033836_llm_council_hybrid_availability.sql", "utf8");
    const evaluator = readFileSync("app/api/agents/llm-council/evaluate/route.ts", "utf8");
    const control = readFileSync("app/api/agents/llm-council/route.ts", "utf8");
    expect(migration).toContain("execution_mode in ('api', 'subscription', 'hybrid')");
    expect(migration).not.toMatch(/update\s+public\.llm_council_model_forecasts/i);
    expect(migration).toContain("execution_source in ('api', 'subscription')");
    expect(migration).toContain("available_at timestamptz;");
    expect(migration).toContain("Historical forecast rows are append-only");
    expect(migration).toContain("p_hash is null or p_hash !~");
    expect(migration).toContain("jsonb_typeof(p_snapshot)<>'object'");
    expect(migration).toContain("execution_mode=y.execution_mode");
    expect(evaluator).toContain('"forecast_available_close_v1"');
    expect(evaluator).toContain('.eq("execution_source", "subscription")');
    expect(evaluator).toContain("availabilityAlignedLabel");
    expect(control).toContain('"api", "subscription", "hybrid"');
    for (const path of ["lib/research-agent.ts", "lib/trading/capital-rotation.ts", "app/api/agents/paper-trade/route.ts"]) {
      expect(readFileSync(path, "utf8")).not.toMatch(/llm[_-]council/i);
    }
  });
});
