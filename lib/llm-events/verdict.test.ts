import { describe, expect, it } from "vitest";
import { eventVerdict, type VerdictCell } from "@/lib/llm-events/verdict";

const cell = (series_key: string, over: Partial<VerdictCell> = {}): VerdictCell => ({ series_key, classification: "measured_descriptive", mean_session_rank_ic: 0.05, t_stat: 2.5, qualifying_sessions: 40, ...over });

describe("event verdict", () => {
  it("says collecting until the partial IC cell meets the evidence gate", () => {
    expect(eventVerdict([]).state).toBe("collecting");
    expect(eventVerdict([cell("event:partial_vs_composite_council", { classification: "insufficient_evidence", qualifying_sessions: 4 })])).toMatchObject({ state: "collecting" });
  });
  it("flags redundancy before value", () => {
    const v = eventVerdict([cell("event:partial_vs_composite_council"), cell("corr:event_vs_council", { mean_session_rank_ic: 0.72 })]);
    expect(v.state).toBe("redundant");
  });
  it("accepts only a positive, significant partial IC", () => {
    expect(eventVerdict([cell("event:partial_vs_composite_council"), cell("corr:event_vs_council", { mean_session_rank_ic: 0.2 })]).state).toBe("adds_information");
    expect(eventVerdict([cell("event:partial_vs_composite_council", { t_stat: 1.1 }), cell("corr:event_vs_council", { mean_session_rank_ic: 0.2 })]).state).toBe("no_incremental_value");
    expect(eventVerdict([cell("event:partial_vs_composite_council", { mean_session_rank_ic: -0.04, t_stat: -2.4 })]).state).toBe("no_incremental_value");
  });
});
