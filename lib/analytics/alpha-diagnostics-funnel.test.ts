import { describe, expect, it } from "vitest";
import { projectAllScoredEntryRows, projectEntryFunnel, type FunnelObservation, type FunnelEvent, type FunnelTrade } from "./alpha-diagnostics-funnel";

const signal = "signal-a";
const day = "2026-10-02";
const ts = `${day}T13:00:00Z`;
const versions = new Map([[signal, { version: "v1", session: day }]]);

function observation(patch: Partial<FunnelObservation> = {}): FunnelObservation {
  return {
    id: 1, signal_id: signal, symbol: "ARM", ts, entry_eligible: true,
    direction: "long", decision_context: "entry_candidate", discovery_source: "watchlist",
    observation_labels: [{ horizon_days: 10, benchmark_neutral_return: 0.12 }],
    ...patch,
  };
}

function event(patch: Partial<FunnelEvent> = {}): FunnelEvent {
  return { signal_id: signal, stage: "execution", outcome: "rejected",
    reason: "max_open_names", created_at: `${day}T19:00:00Z`, ...patch };
}

function trade(patch: Partial<FunnelTrade> = {}): FunnelTrade {
  return { signal_id: signal, executed_at: `${day}T19:01:00Z`, closed_at: null,
    tainted: false, excluded_from_learning: false, ...patch };
}

describe("A1 persisted funnel projection", () => {
  it("attributes a selected but blocked entry to the exact paper-trader signal", () => {
    const rows = projectEntryFunnel([observation()], versions, [event(), event()], [], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "selected", attritionReason: "max_open_names", benchmarkNeutralReturn: 0.12 });
    expect(projectEntryFunnel([observation()], versions, [event({ signal_id: "other" })], [], 10)[0].stage)
      .toBe("entry_eligible");
  });

  it("excludes holding reviews, shadow events, and events on a different session", () => {
    expect(projectEntryFunnel([observation({ decision_context: "holding_review" })], versions, [event()], [], 10))
      .toEqual([]);
    expect(projectEntryFunnel([observation()], versions, [event({ stage: "correlation_shadow" })], [], 10)[0].stage)
      .toBe("entry_eligible");
    expect(projectEntryFunnel([observation()], versions, [event({ created_at: "2026-10-03T19:00:00Z" })], [], 10)[0].stage)
      .toBe("entry_eligible");
  });

  it("requires an actual lot for filled and all original lots closed for closed", () => {
    expect(projectEntryFunnel([observation()], versions, [event({ outcome: "filled" })], [], 10)[0].stage)
      .toBe("selected");
    expect(projectEntryFunnel([observation()], versions, [], [trade()], 10)[0].stage).toBe("filled");
    expect(projectEntryFunnel([observation()], versions, [], [trade({ closed_at: "2026-10-09T20:00:00Z" }), trade()], 10)[0].stage)
      .toBe("filled");
    expect(projectEntryFunnel([observation()], versions, [], [trade({ closed_at: "2026-10-09T20:00:00Z" })], 10)[0].stage)
      .toBe("closed");
    expect(projectEntryFunnel([observation()], versions, [], [trade({ tainted: true })], 10)[0].stage)
      .toBe("entry_eligible");
  });

  it("does not replace an immature label with zero or another horizon", () => {
    expect(projectEntryFunnel([observation()], versions, [], [], 5)[0].benchmarkNeutralReturn).toBeNull();
    expect(projectEntryFunnel([observation({ observation_labels: [{ horizon_days: 10, benchmark_neutral_return: null }] })], versions, [], [], 10)[0].benchmarkNeutralReturn).toBeNull();
  });

  it("chooses the first entry decision per symbol/session before seeing outcome", () => {
    const later = observation({ id: 2, signal_id: "signal-b", ts: `${day}T14:00:00Z`,
      observation_labels: [{ horizon_days: 10, benchmark_neutral_return: -0.5 }] });
    const sources = new Map(versions).set("signal-b", { version: "v1", session: day });
    const rows = projectEntryFunnel([later, observation()], sources,
      [event({ signal_id: "signal-b" })], [], 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: "entry_eligible", benchmarkNeutralReturn: 0.12 });
  });

  it("separates all-scored context from eligible-long conversion", () => {
    const ineligible = observation({ entry_eligible: false, direction: "neutral" });
    expect(projectEntryFunnel([ineligible], versions, [event()], [trade()], 10)).toEqual([]);
    expect(projectAllScoredEntryRows([ineligible], versions, 10)[0]).toMatchObject({ stage: "scored", benchmarkNeutralReturn: 0.12 });
  });

  it("keeps first all-scored and first eligible decisions distinct", () => {
    const initial = observation({ entry_eligible: false, direction: "neutral" });
    const later = observation({ id: 2, signal_id: "signal-b", ts: `${day}T14:00:00Z`,
      observation_labels: [{ horizon_days: 10, benchmark_neutral_return: -0.2 }] });
    const sources = new Map(versions).set("signal-b", { version: "v1", session: day });
    expect(projectAllScoredEntryRows([later, initial], sources, 10)[0].benchmarkNeutralReturn).toBe(0.12);
    expect(projectEntryFunnel([later, initial], sources, [event({ signal_id: "signal-b" })], [], 10)[0])
      .toMatchObject({ stage: "selected", benchmarkNeutralReturn: -0.2 });
  });
});
