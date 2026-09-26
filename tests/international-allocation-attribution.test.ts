import { describe, expect, it } from "vitest";
import { buildInternationalAllocationAttribution } from "@/lib/allocation/international-attribution";

function sessions(count: number): string[] {
  const dates: string[] = [];
  const date = new Date("2022-01-03T00:00:00Z");
  while (dates.length < count) {
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

describe("international allocation attribution producer", () => {
  it("creates matched gross/net portfolio evidence with independent-block uncertainty and explicit synthetic scope", () => {
    const dates = sessions(800);
    const voo = dates.map((date, index) => ({ date, close: 400 * (1 + index * 0.0003 + Math.sin(index / 18) * 0.006) }));
    const vxus = dates.map((date, index) => ({ date, close: 55 * (1 + index * 0.00024 + Math.cos(index / 17) * 0.009) }));
    const result = buildInternationalAllocationAttribution(voo, vxus);
    expect(result.row?.state).toBe("measured");
    expect(result.row?.program_id).toBe("international-allocation");
    expect(result.row?.baseline_version).toContain("voo-buy-hold");
    expect(result.row?.baseline_net_portfolio_return_pct).toBe(result.row?.baseline_portfolio_return_pct);
    expect(result.row?.net_incremental_return_pct).toBeCloseTo(
      result.row!.variant_net_portfolio_return_pct! - result.row!.baseline_net_portfolio_return_pct!, 6,
    );
    expect(result.row?.independent_sessions).toBeGreaterThanOrEqual(2);
    expect(result.row?.constraints.synthetic_portfolio_not_kairos_book).toBe(true);
    expect(result.row?.matched_population_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.row?.input_snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not claim a portfolio result when matched price history is below the predeclared floor", () => {
    const dates = sessions(600);
    const bars = dates.map((date, index) => ({ date, close: 100 + index }));
    const result = buildInternationalAllocationAttribution(bars, bars);
    expect(result.row).toBeNull();
    expect(result.replay.status).toBe("insufficient_history");
    expect(result.reason).toContain("756 matched");
  });

  it("keeps immutable attribution idempotent when one leg has unused trailing bars past the common as-of session", () => {
    const dates = sessions(800);
    const voo = dates.map((date, index) => ({ date, close: 400 * (1 + index * 0.0003 + Math.sin(index / 18) * 0.006) }));
    const vxus = dates.map((date, index) => ({ date, close: 55 * (1 + index * 0.00024 + Math.cos(index / 17) * 0.009) }));
    const first = buildInternationalAllocationAttribution(voo, vxus);
    const withUnusedTail = buildInternationalAllocationAttribution([
      ...voo, { date: "2026-12-31", close: 999 },
    ], vxus);
    expect(withUnusedTail.row?.as_of_session).toBe(first.row?.as_of_session);
    expect(withUnusedTail.row?.input_snapshot_hash).toBe(first.row?.input_snapshot_hash);
  });

  it("fails closed when a session is missing from one leg instead of shrinking the sample invisibly", () => {
    const dates = sessions(800);
    const bars = dates.map((date, index) => ({ date, close: 100 + index }));
    const result = buildInternationalAllocationAttribution(bars, bars.slice(1));
    expect(result.row).toBeNull();
    expect(result.replay.sessions).toBe(799);
  });
});
