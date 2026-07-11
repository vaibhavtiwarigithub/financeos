// P3/P4 — Required Test 15: MU/INTC/GME-style frozen historical packets run without
// future data and report WHETHER/WHEN each model becomes eligible — no handpicked
// future-return dates. The first-eligible date is chosen by the REAL gate; the test
// asserts the gate-selected property, faithful reuse, and the no-leak guarantee — it
// does NOT hardcode an outcome date.

import { describe, it, expect } from "vitest";
import type { LabeledObservation } from "@/lib/learning/dataset";
import { fitCalibration } from "@/lib/validation/calibration";
import { runCohortReplay, type CohortReplayInput } from "@/lib/replay/cursor";
import { buildEligibilityReport, type ForwardReturnLookup } from "@/lib/replay/reporter";
import { freezeObservationsAsOf } from "@/lib/replay/packet-assembler";
import { inMemorySupabase, observationsToTables } from "@/lib/replay/mock-supabase";
import { SealedDataAccessor, FutureDataLeakError } from "@/lib/replay/sealed-accessor";

const DAY = 86400_000;
const BASE = Date.UTC(2022, 5, 1); // 2022-06-01

function isoDay(dayOffset: number): string {
  return new Date(BASE + dayOffset * DAY).toISOString();
}

// Deterministic broad training universe: identical dimension scores (so standardized
// features are ~0 and predictions ~ base rate → well-calibrated, ECE≈0) with an
// evenly-interleaved 50/50 win/loss outcome (not degenerate). "Eligible" therefore
// emerges purely from how many labels have MATURED by each as-of — a data-selected
// date, never a handpicked one.
function buildUniverse(n: number): LabeledObservation[] {
  const rows: LabeledObservation[] = [];
  for (let i = 1; i <= n; i++) {
    const win = i % 2 === 0;
    rows.push({
      id: i, ts: isoDay(i), market: "us", symbol: `U${i % 40}`,
      analyst_score: 60, fundamental_score: 60, technical_score: 60,
      sentiment_score: 60, macro_score: 60, insider_score: 60,
      direction: "long", entry_eligible: true, score_threshold: 60, availability_mask: null,
      horizon_days: 10,
      fwd_return: win ? 0.01 : -0.01,
      benchmark_return: 0,
      benchmark_neutral_return: win ? 0.01 : -0.01,
      max_adverse_excursion: -0.02, max_favorable_excursion: 0.03,
    });
  }
  return rows;
}

// Reference verdict: run the REAL fitCalibration over the same sealed observations the
// cursor would see. Proves the cursor reuses the gate faithfully (no reimplementation).
async function referenceAccepted(obs: LabeledObservation[], asOf: string): Promise<boolean> {
  const sealed = freezeObservationsAsOf(obs, asOf, 10).map((s) => s.observation);
  const fit = await fitCalibration(inMemorySupabase(observationsToTables(sealed)) as any, "us", 10);
  return !!fit?.oos.accepted;
}

describe("Test 15 — frozen cohort eligibility (gate-selected, leak-free)", () => {
  const universe = buildUniverse(180);
  const asOfDates = [
    "2022-07-01", "2022-07-20", "2022-08-10", "2022-09-01",
    "2022-09-25", "2022-10-20", "2022-11-15", "2022-12-10", "2023-01-10",
  ];

  const input: CohortReplayInput = {
    cohort: "semis_memory_2022",
    market: "us",
    horizonDays: 10,
    asOfDates,
    observations: universe,
    namedSymbols: ["MU", "INTC", "GME"],
    dimensionSnapshots: {
      // MU: from 2022-09-01, 3 usable dimensions → non-thin (entry-eligible).
      MU: [
        { asOf: "2022-09-01", scores: { fundamental: 70, technical: 65, sentiment: 60 },
          included: { fundamental: true, technical: true, sentiment: true } },
      ],
      // INTC: from 2022-10-20, 2 usable dimensions → exactly clears the thin floor.
      INTC: [
        { asOf: "2022-10-20", scores: { fundamental: 55, technical: 52 },
          included: { fundamental: true, technical: true } },
      ],
      // GME: only 1 dimension ever usable → ABSTAIN. The honest "not an entry" case
      // (its real signal is an exit/veto, deferred — draft §8). Reports "never".
      GME: [
        { asOf: "2022-07-01", scores: { technical: 80 }, included: { technical: true } },
      ],
    },
  };

  it("runs the full window without leaking future data (no throw)", async () => {
    await expect(runCohortReplay(input)).resolves.toBeTruthy();
  });

  it("cursor's calibration verdict matches the real fitCalibration gate at every as-of", async () => {
    const { events } = await runCohortReplay(input);
    for (const asOf of asOfDates) {
      const ev = events.find((e) => e.gate === "calibration_oos" && e.asOf === asOf)!;
      expect(ev.passed).toBe(await referenceAccepted(universe, asOf));
    }
  });

  it("first-eligible date is GATE-SELECTED: earliest as-of fails, a later as-of passes", async () => {
    const { events } = await runCohortReplay(input);
    const report = buildEligibilityReport(events);
    const cal = report.find((r) => r.scope === "semis_memory_2022" && r.gate === "calibration_oos")!;

    // A model DOES become eligible somewhere in the window …
    expect(cal.firstEligibleAsOf).not.toBeNull();
    // … and the earliest as-of (too little matured history) is NOT it.
    expect(cal.firstEligibleAsOf).not.toBe(asOfDates[0]);

    // firstEligibleAsOf is exactly MIN(as_of WHERE passed) over the events — the
    // reporter never consults a return series to choose it.
    const passDates = events
      .filter((e) => e.gate === "calibration_oos" && e.passed)
      .map((e) => e.asOf)
      .sort();
    expect(cal.firstEligibleAsOf).toBe(passDates[0]);

    // Every as-of strictly before the first-eligible date failed the gate.
    for (const e of events.filter((e) => e.gate === "calibration_oos" && e.asOf < cal.firstEligibleAsOf!)) {
      expect(e.passed).toBe(false);
    }
  });

  it("reports per-symbol thin-evidence honestly: MU/INTC eligible, GME never (abstain)", async () => {
    const { events } = await runCohortReplay(input);
    const report = buildEligibilityReport(events);

    const mu = report.find((r) => r.scope === "MU" && r.gate === "thin_evidence")!;
    const intc = report.find((r) => r.scope === "INTC" && r.gate === "thin_evidence")!;
    const gme = report.find((r) => r.scope === "GME" && r.gate === "thin_evidence")!;

    expect(mu.firstEligibleAsOf).toBe("2022-09-01");
    expect(intc.firstEligibleAsOf).toBe("2022-10-20");
    expect(gme.firstEligibleAsOf).toBeNull();
    expect(gme.note).toMatch(/never eligible/);
  });

  it("forward return is a CONSEQUENCE read strictly AFTER the eligibility date", async () => {
    const { events } = await runCohortReplay(input);
    // Simple MU price series: rising after eligibility. Used ONLY to annotate outcome.
    const muPrices: Record<string, number> = {
      "2022-09-01": 50, "2022-09-11": 55, "2022-09-30": 60,
    };
    const lookup: ForwardReturnLookup = {
      priceOnOrAfter(symbol, date) {
        if (symbol !== "MU") return null;
        const dates = Object.keys(muPrices).sort();
        const hit = dates.find((d) => d >= date);
        return hit ? { date: hit, close: muPrices[hit] } : null;
      },
    };
    const report = buildEligibilityReport(events, { forwardReturn: lookup, forwardHorizonDays: 10 });
    const mu = report.find((r) => r.scope === "MU" && r.gate === "thin_evidence")!;

    expect(mu.forwardReturnAfter).not.toBeNull();
    // The consequence date is STRICTLY later than the eligibility date — never used to
    // pick it.
    expect(mu.forwardReturnAsOf! > mu.firstEligibleAsOf!).toBe(true);
  });

  it("leak guard also covers packet items in cohort context (deliberate future candle throws)", () => {
    const acc = new SealedDataAccessor("2022-09-01", {
      items: [
        { itemType: "ohlcv", symbol: "MU", knowableAt: "2022-08-30", payload: { close: 50 }, payloadHash: "a" },
        { itemType: "ohlcv", symbol: "MU", knowableAt: "2022-11-01", payload: { close: 62 }, payloadHash: "b" }, // future
      ],
    });
    expect(() => acc.prices("MU")).toThrow(FutureDataLeakError);
  });
});
