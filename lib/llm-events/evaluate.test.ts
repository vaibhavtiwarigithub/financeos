import { describe, expect, it } from "vitest";
import { evaluatePairs, pairEventScores, partialIcCell, type ObservationRow, type PairedRow } from "@/lib/llm-events/evaluate";

function rng(seed: number) { let s = seed; return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5); }
const day = (i: number) => new Date(Date.UTC(2026, 5, 1 + i, 4, 0, 0)).toISOString();

/** 40 sessions x 25 symbols. outcome = 0.5*hidden + noise; council sees only a noisy copy of `shared`; event sees hidden. */
function synth(mode: "independent" | "copy"): PairedRow[] {
  const r = rng(11);
  const rows: PairedRow[] = [];
  for (let d = 0; d < 40; d++) for (let s = 0; s < 25; s++) {
    const shared = r() * 10;
    const hidden = r() * 10;
    const council = 50 + shared + r();
    const analyst = 50 + shared + r() * 2;
    const event = mode === "copy" ? council + r() * 0.2 : 50 + hidden;
    const outcome = mode === "copy" ? shared * 0.01 + r() * 0.02 : hidden * 0.01 + shared * 0.005 + r() * 0.02;
    rows.push({ symbol: `S${s}`, ts: day(d), event, council, analyst, outcome });
  }
  return rows;
}

describe("llm event evaluator", () => {
  it("pairs each observation with the latest score computed at or before it, within 3 days, never after", () => {
    const obs: ObservationRow[] = [{ symbol: "A", ts: "2026-06-10T04:00:00Z", council: 50, analyst: 55, outcome: 0.01 }];
    const paired = pairEventScores(obs, [
      { symbol: "A", as_of: "2026-06-09T13:10:00Z", score: 62 },
      { symbol: "A", as_of: "2026-06-10T13:10:00Z", score: 99 }, // later than the observation: must be ignored
    ]);
    expect(paired).toHaveLength(1);
    expect(paired[0].event).toBe(62);
    expect(pairEventScores(obs, [{ symbol: "A", as_of: "2026-06-05T13:10:00Z", score: 62 }])).toHaveLength(0); // stale
    expect(pairEventScores([{ ...obs[0], council: null }], [{ symbol: "A", as_of: "2026-06-09T13:10:00Z", score: 62 }])).toHaveLength(0);
  });
  it("finds positive partial IC when the event score carries information the council and composite lack", () => {
    const cell = partialIcCell("p", 5, synth("independent"));
    expect(cell.qualifyingSessions).toBe(40);
    expect(cell.mean!).toBeGreaterThan(0.3);
  });
  it("finds ~zero partial IC and high correlation when the event score is a copy of the council", () => {
    const cells = evaluatePairs(5, synth("copy"));
    const partial = cells.find((c) => c.seriesKey === "event:partial_vs_composite_council")!;
    const corr = cells.find((c) => c.seriesKey === "corr:event_vs_council")!;
    expect(Math.abs(partial.mean!)).toBeLessThan(0.2);
    expect(corr.mean!).toBeGreaterThan(0.9);
  });
  it("marks short histories as insufficient evidence and gives no t-stat", () => {
    const rows = synth("independent").filter((r) => r.ts < day(5));
    const cell = evaluatePairs(5, rows).find((c) => c.seriesKey === "event:score")!;
    expect(cell.classification).toBe("insufficient_evidence");
    expect(cell.tStat).toBeNull();
  });
  it("flags redundancy in the reason only once the evidence gate is met", () => {
    const cells = evaluatePairs(2, synth("copy")); // 40 sessions / h2 = 20 windows >= 12
    const corr = cells.find((c) => c.seriesKey === "corr:event_vs_council")!;
    expect(corr.classification).toBe("measured_descriptive");
    expect(corr.reason).toContain("redundant with the council");
  });
});
