import { describe, it, expect } from "vitest";
import { computeArchetypeIc, dedupeRows, spearman, type ArchetypeScoreRow } from "./archetype-ic";
import { MIN_PREDICTIVE_DATES } from "./dimension-diagnostics";

function row(over: Partial<ArchetypeScoreRow> = {}): ArchetypeScoreRow {
  return {
    market: "us", setupType: "value_inflection", symbol: "AAA",
    date: "2026-01-05", ts: "2026-01-05T13:00:00Z",
    score: 70, championScore: 60, forwardReturn: 0.01,
    ...over,
  };
}

/** `dates` sessions x `perDate` names. `fn` sets each row's score/return. */
function series(dates: number, perDate: number, fn: (i: number) => { score: number; championScore: number; forwardReturn: number }) {
  const out: ArchetypeScoreRow[] = [];
  for (let d = 0; d < dates; d++) {
    const date = `2026-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String((d % 28) + 1).padStart(2, "0")}`;
    for (let i = 0; i < perDate; i++) {
      out.push(row({ date, ts: `${date}T13:00:00Z`, symbol: `S${i}`, ...fn(i) }));
    }
  }
  return out;
}

describe("spearman", () => {
  it("is 1 for a perfectly monotonic but non-linear relationship", () => {
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])!).toBeCloseTo(1, 6);
  });

  it("returns null rather than 0 when one side has no variance", () => {
    // 0.0 would read as "measured no relationship"; nothing was measurable.
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBeNull();
  });
});

describe("dedupeRows", () => {
  // The research cron writes 2-3x per day. Undeduped, a symbol carries 2-3x
  // weight inside one cross-section.
  it("keeps the earliest row per (market, setupType, symbol, date)", () => {
    const kept = dedupeRows([
      row({ ts: "2026-01-05T18:00:00Z", score: 99 }),
      row({ ts: "2026-01-05T13:00:00Z", score: 70 }),
      row({ ts: "2026-01-05T17:00:00Z", score: 88 }),
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0].score).toBe(70);
  });

  it("does not collapse distinct symbols, dates, or setup types", () => {
    expect(dedupeRows([
      row(), row({ symbol: "BBB" }), row({ date: "2026-01-06" }), row({ setupType: "quality_momentum" }),
    ])).toHaveLength(4);
  });
});

describe("computeArchetypeIc", () => {
  const strong = (i: number) => ({ score: 50 + i * 5, championScore: 50 + i, forwardReturn: i * 0.01 });

  it("refuses a conclusion below the date floor", () => {
    const r = computeArchetypeIc(series(5, 6, strong), 10)!;
    expect(r.status).toBe("insufficient_evidence");
    expect(r.reason).toContain("sessions have a cross-section");
  });

  // The overlap guard. 20 dates clears the date floor, but 20 windows of 120
  // days overlap to 0.17 independent observations.
  it("refuses a conclusion at h120 even with enough dates", () => {
    const r = computeArchetypeIc(series(MIN_PREDICTIVE_DATES, 6, strong), 120)!;
    expect(r.status).toBe("insufficient_evidence");
    expect(r.reason).toContain("independent observations");
    expect(r.effectiveObs).toBeCloseTo(MIN_PREDICTIVE_DATES / 120, 4);
  });

  it("measures when both floors clear", () => {
    const r = computeArchetypeIc(series(30, 6, strong), 2)!;
    expect(r.status).toBe("measured");
    expect(r.rankIc!).toBeCloseTo(1, 6);
  });

  // The comparison that gives the number meaning: champion graded on the SAME
  // rows, so a positive delta cannot be a cohort artefact.
  it("reports the champion's IC on the same observations and the paired delta", () => {
    // Archetype ranks returns perfectly; champion ranks them exactly backwards.
    const rows = series(30, 6, i => ({ score: 50 + i * 5, championScore: 100 - i * 5, forwardReturn: i * 0.01 }));
    const r = computeArchetypeIc(rows, 2)!;
    expect(r.rankIc!).toBeCloseTo(1, 6);
    expect(r.championRankIc!).toBeCloseTo(-1, 6);
    expect(r.icDeltaVsChampion!).toBeCloseTo(2, 6);
  });

  it("skips sessions with too thin a cross-section rather than scoring them", () => {
    // 3 names per date is below MIN_CROSS_SECTION; nothing qualifies.
    const r = computeArchetypeIc(series(30, 3, strong), 2)!;
    expect(r.qualifyingSessions).toBe(0);
    expect(r.status).toBe("insufficient_evidence");
  });

  it("counts sessions, not rows, so duplicates cannot buy their way past the floor", () => {
    const once = series(MIN_PREDICTIVE_DATES, 6, strong);
    const tripled = [
      ...once,
      ...once.map(r => ({ ...r, ts: r.ts.replace("13:", "17:") })),
      ...once.map(r => ({ ...r, ts: r.ts.replace("13:", "18:") })),
    ];
    const a = computeArchetypeIc(once, 2)!;
    const b = computeArchetypeIc(tripled, 2)!;
    expect(b.qualifyingSessions).toBe(a.qualifyingSessions);
    expect(b.observations).toBe(a.observations);
  });

  it("returns null for an empty arm rather than a zeroed row", () => {
    expect(computeArchetypeIc([], 10)).toBeNull();
  });
});
