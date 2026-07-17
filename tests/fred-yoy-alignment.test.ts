import { describe, it, expect } from "vitest";
import { observationMonthsBefore, type FredObservation } from "@/lib/data/fred-macro";
import systemMap from "@/public/agent-diagrams/system-map.json";

// The real FRED CPIAUCSL response on 2026-07-17 (sort_order=desc, limit=13).
// Note the "." at 2025-10 — FRED's missing-value marker. This is why CPI had
// never loaded: the adapter drops non-finite values, so asking for exactly 13
// yielded 12 and the `>= 13` guard failed on every run since the FRED cutover.
const LIVE_CPI: FredObservation[] = [
  { date: "2026-06-01", value: 332.568 },
  { date: "2026-05-01", value: 333.979 },
  { date: "2026-04-01", value: 332.407 },
  { date: "2026-03-01", value: 330.293 },
  { date: "2026-02-01", value: 327.46 },
  { date: "2026-01-01", value: 326.588 },
  { date: "2025-12-01", value: 326.031 },
  { date: "2025-11-01", value: 325.063 },
  // 2025-10-01 is "." upstream -> dropped by the adapter -> the array COLLAPSES here
  { date: "2025-09-01", value: 324.245 },
  { date: "2025-08-01", value: 323.291 },
  { date: "2025-07-01", value: 322.169 },
  { date: "2025-06-01", value: 321.435 },
];

describe("FRED YoY alignment", () => {
  it("matches the paired month by DATE, not by array index", () => {
    const latest = LIVE_CPI[0]!;
    const yearAgo = observationMonthsBefore(LIVE_CPI, latest.date, 12);
    expect(yearAgo?.date).toBe("2025-06-01");
  });

  it("index arithmetic on a gap-collapsed array is WRONG, not merely short", () => {
    // This is the bug being fixed. A dropped month shifts every later index, so
    // vals[12] is not "12 months ago". With the live gap the array is only 12 long,
    // so vals[12] is undefined; had FRED returned one more row it would silently
    // have paired 2026-06 against 2025-05 — a 13-month "YoY".
    const naive = LIVE_CPI[12];
    expect(naive).toBeUndefined();

    const padded = [...LIVE_CPI, { date: "2025-05-01", value: 320.58 }];
    expect(padded[12]!.date).toBe("2025-05-01"); // 13 months back, mislabelled as YoY
    expect(observationMonthsBefore(padded, padded[0]!.date, 12)?.date).toBe("2025-06-01");
  });

  it("abstains when the paired month is genuinely absent — never guesses a neighbour", () => {
    // Ask for the month that IS the upstream gap.
    const fromNov = observationMonthsBefore(LIVE_CPI, "2026-10-01", 12);
    expect(fromNov).toBeNull(); // 2025-10 was "." -> honest absence
  });

  it("computes the true YoY from the live fixture", () => {
    const latest = LIVE_CPI[0]!;
    const yearAgo = observationMonthsBefore(LIVE_CPI, latest.date, 12)!;
    const yoy = ((latest.value - yearAgo.value) / yearAgo.value) * 100;
    expect(yoy).toBeCloseTo(3.46, 1); // 332.568 vs 321.435
  });
});

describe("system-map node/diagram integrity", () => {
  // AgentDiagram.tsx:103-105 emits `class <id> <status>` for EVERY nodes key and
  // appends it to the mermaid source. A key absent from the diagram is a `class`
  // against an unknown id. ROTATION/BENCHALPHA/EARNPIT/INDIAFILL were orphaned
  // this way — real, shipped flows that the map documented but never drew.
  const map = systemMap as { diagram: string; nodes: Record<string, unknown> };

  it("every nodes key appears in the diagram", () => {
    const orphans = Object.keys(map.nodes).filter((k) => !new RegExp(`\\b${k}\\b`).test(map.diagram));
    expect(orphans).toEqual([]);
  });

  it("the orphan check can actually fail", () => {
    // Guard the guard: a check that cannot fail is worse than no check.
    expect(new RegExp(`\\bZZ_NOT_A_NODE\\b`).test(map.diagram)).toBe(false);
  });
});
