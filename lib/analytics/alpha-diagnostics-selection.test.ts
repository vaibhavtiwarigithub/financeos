import { describe, it, expect } from "vitest";
import { runA2Selection, dedupeSelectionRows, selectionRowsFromObservations } from "./alpha-diagnostics-selection";
import type { SelectionRow } from "./alpha-diagnostics";

type Row = SelectionRow & { ts?: string };

/** `dates` sessions x `perDate` names, forward return set by `fn`. */
function series(dates: number, perDate: number, fn: (i: number) => number): Row[] {
  const out: Row[] = [];
  for (let d = 0; d < dates; d++) {
    const date = `2026-06-${String((d % 28) + 1).padStart(2, "0")}`;
    for (let i = 0; i < perDate; i++) {
      out.push({ date, symbol: `S${i}`, score: 50 + i * 5, forwardReturn: fn(i), ts: `${date}T13:00:00Z` });
    }
  }
  return out;
}

describe("dedupeSelectionRows", () => {
  // The research cron writes 2-3 observations per symbol per day. Undeduped,
  // those symbols carry 2-3x weight WITHIN a single cross-section.
  it("keeps the earliest row per symbol per date", () => {
    const kept = dedupeSelectionRows([
      { date: "d1", symbol: "AAA", score: 99, forwardReturn: 0.9, ts: "d1T18:00:00Z" },
      { date: "d1", symbol: "AAA", score: 70, forwardReturn: 0.1, ts: "d1T13:00:00Z" },
      { date: "d1", symbol: "AAA", score: 80, forwardReturn: 0.5, ts: "d1T17:00:00Z" },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(70);
  });

  it("does not collapse distinct symbols or dates", () => {
    expect(dedupeSelectionRows([
      { date: "d1", symbol: "AAA", score: 1, forwardReturn: 0 },
      { date: "d1", symbol: "BBB", score: 1, forwardReturn: 0 },
      { date: "d2", symbol: "AAA", score: 1, forwardReturn: 0 },
    ])).toHaveLength(3);
  });

  it("strips the ordering timestamp from the result", () => {
    const [r] = dedupeSelectionRows([{ date: "d", symbol: "A", score: 1, forwardReturn: 0, ts: "x" }]);
    expect("ts" in r).toBe(false);
  });
});

describe("runA2Selection", () => {
  it("uses eligible-long rows even when the all-scored headline has the opposite sign", () => {
    const observations: any[] = [];
    for (let d = 0; d < 30; d++) {
      const date = `2026-07-${String(d + 1).padStart(2, "0")}`;
      for (let i = 0; i < 5; i++) observations.push({
        symbol: `E${i}`, ts: `${date}T10:00:00Z`, analyst_score: i,
        entry_eligible: true, direction: "long",
        observation_labels: [{ horizon_days: 2, benchmark_neutral_return: -i }],
      });
      for (let i = 0; i < 20; i++) observations.push({
        symbol: `C${i}`, ts: `${date}T09:00:00Z`, analyst_score: 10 + i,
        entry_eligible: false, direction: "neutral",
        observation_labels: [{ horizon_days: 2, benchmark_neutral_return: 10 + i }],
      });
    }
    const eligible = selectionRowsFromObservations(observations, 2, "eligible_long");
    const all = selectionRowsFromObservations(observations, 2, "all_scored");
    expect(runA2Selection("us", eligible, 2, 20).metrics.rankIc as number).toBeCloseTo(-1, 8);
    expect(runA2Selection("us", all, 2, 20).metrics.rankIc as number).toBeGreaterThan(0);
  });
  it("reports a positive IC and spread when the score ranks returns", () => {
    const f = runA2Selection("us", series(30, 8, i => i * 0.01), 2, 20);
    expect(f.status).toBe("descriptive_only");
    expect(f.metrics.rankIc as number).toBeCloseTo(1, 6);
    expect(f.metrics.meanQuintileSpread as number).toBeGreaterThan(0);
    expect(f.metrics.pooledMonotonic).toBe(true);
  });

  it("reports a negative IC when the ranking is backwards", () => {
    const f = runA2Selection("us", series(30, 8, i => -i * 0.01), 2, 20);
    expect(f.metrics.rankIc as number).toBeCloseTo(-1, 6);
    expect(f.metrics.meanQuintileSpread as number).toBeLessThan(0);
  });

  // Counting rows instead of dates is the error this whole suite guards against.
  it("counts DATES, not rows, so duplicates cannot buy past the floor", () => {
    const once = series(10, 8, i => i * 0.01);
    const tripled = [
      ...once,
      ...once.map(r => ({ ...r, ts: r.ts!.replace("13:", "17:") })),
      ...once.map(r => ({ ...r, ts: r.ts!.replace("13:", "18:") })),
    ];
    const a = runA2Selection("us", once, 2, 20);
    const b = runA2Selection("us", tripled, 2, 20);
    expect(b.sample.nDates).toBe(a.sample.nDates);
    expect(b.sample.nRows).toBe(a.sample.nRows);
    expect(b.status).toBe("insufficient_evidence");
  });

  it("skips sessions whose cross-section is too thin to rank", () => {
    // 3 names per date, below the default minimum of 5.
    const f = runA2Selection("us", series(30, 3, i => i * 0.01), 2, 20);
    expect(f.metrics.qualifyingSessions).toBe(0);
    expect(f.status).toBe("insufficient_evidence");
  });

  it("refuses a long horizon whose windows overlap, even past the date floor", () => {
    const f = runA2Selection("us", series(25, 8, i => i * 0.01), 120, 20);
    expect(f.status).toBe("insufficient_evidence");
    expect(f.reason).toContain("independent observations");
  });

  // A positive IC with a flat spread is a ranking that cannot be traded.
  it("separates a correlating ranking from a payable one", () => {
    // Monotonic in score but the payoff is concentrated in one bucket, so the
    // pooled sequence is not monotonic.
    const rows = series(30, 10, i => (i === 9 ? 0.5 : 0.0001 * i));
    const f = runA2Selection("us", rows, 2, 20);
    expect(f.metrics.rankIc as number).toBeGreaterThan(0);
    expect(f.metrics.pooledQuintileSpread as number).toBeGreaterThan(0);
  });

  it("reports coverage after deduplication", () => {
    const once = series(5, 8, i => i * 0.01);
    const doubled = [...once, ...once.map(r => ({ ...r, ts: r.ts!.replace("13:", "17:") }))];
    const f = runA2Selection("us", doubled, 2, 1);
    expect(f.coverage).toBeCloseTo(0.5, 6);
    expect(f.metrics.dedupedFrom).toBe(doubled.length);
  });
});
