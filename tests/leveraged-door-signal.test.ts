import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateLeveragedResearchGate, RESEARCH_GATE_MAX_AGE_MS, type ResearchSignalRow } from "@/lib/trading/leveraged-door-signal";

const now = Date.UTC(2026, 8, 29, 15, 5);
const good: ResearchSignalRow = { id: "s1", direction: "long", analyst_score: 65, score_source: "deterministic_v1",
  created_at: new Date(now - 3_600_000).toISOString(), status: "pending", session_validated: true };
const gate = (over: Partial<ResearchSignalRow> | null, threshold = 60) =>
  evaluateLeveragedResearchGate(over == null ? null : { ...good, ...over }, { threshold, now });

describe("leveraged research gate (routed design, fail-closed)", () => {
  it("passes a fresh validated deterministic long at/above threshold", () => {
    expect(gate({})).toMatchObject({ ok: true, signalId: "s1", score: 65 });
    expect(gate({ analyst_score: "60" })).toMatchObject({ ok: true });
  });
  it.each([
    [null, "no_research_signal"],
    [{ direction: "neutral" }, "signal_not_long"],
    [{ direction: "short" }, "signal_not_long"],
    [{ analyst_score: 59.9 }, "signal_below_threshold"],
    [{ analyst_score: null }, "signal_score_missing"],
    [{ analyst_score: "abc" }, "signal_score_missing"],
    [{ score_source: "llm" }, "signal_not_deterministic"],
    [{ session_validated: false }, "signal_not_session_validated"],
    [{ session_validated: null }, "signal_not_session_validated"],
    [{ created_at: new Date(now - RESEARCH_GATE_MAX_AGE_MS - 1).toISOString() }, "signal_stale"],
    [{ created_at: new Date(now + 1000).toISOString() }, "signal_time_invalid"],
    [{ created_at: "garbage" }, "signal_time_invalid"],
  ])("refuses %j -> %s", (over, reason) => {
    expect(gate(over as any)).toEqual({ ok: false, reason });
  });
  it("refuses an invalid threshold", () => {
    expect(gate({}, Number.NaN)).toEqual({ ok: false, reason: "invalid_threshold" });
    expect(gate({}, 0)).toEqual({ ok: false, reason: "invalid_threshold" });
  });
});

describe("routed design wiring (contract)", () => {
  for (const sym of ["soxl", "tqqq", "sqqq", "soxs"]) {
    const route = readFileSync(`app/api/agents/${sym}/cron/route.ts`, "utf8");
    it(`${sym} door requires the research gate before planning and uses the door quote`, () => {
      const gateAt = route.indexOf("evaluateLeveragedResearchGate(");
      const planAt = route.search(/const plan = plan\w+Entry\(/);
      expect(gateAt).toBeGreaterThan(0);
      expect(gateAt).toBeLessThan(planAt);
      expect(route).toContain("quote: doorQuote,");
      expect(route).not.toContain("quote.bid ?? NaN");
      // kairos_call_agent always POSTs; a GET-only door answers 405 and never runs.
      expect(route).toContain("export const POST = GET;");
      // supabase-js builders have no .catch(); `.insert(...).catch` threw TypeError -> 500 and no liveness row.
      expect(route).not.toMatch(/as any\)\.catch\(/);
      expect(route).toMatch(/const \{ error \} = await supabase\.from\("agent_runs"\)\.insert/);
    });
  }
  it("generic paths still block the sleeve and research still scores it", () => {
    const policy = readFileSync("lib/trading/symbol-policy.ts", "utf8");
    expect(policy).toContain('isLeveragedInverseEtf(sym) && !leveragedSleeveExempt');
    const research = readFileSync("lib/research-agent.ts", "utf8");
    expect(research).toContain("for (const sym of LEVERAGED_SLEEVE_SYMBOLS) addCandidate");
    // Must be admitted BEFORE the 186-name watchlist: the wall-clock budget cuts the tail, and the four doors
    // need a same-weekday session-validated signal (weekend-staged signals are never validated).
    expect(research.indexOf("for (const sym of LEVERAGED_SLEEVE_SYMBOLS) addCandidate"))
      .toBeLessThan(research.indexOf("for (const sym of watchlist.usManual) addCandidate"));
    expect(readFileSync("app/api/agents/paper-trade/route.ts", "utf8")).toContain("routed_to_leveraged_door");
  });
});

describe("pg_cron schedule migration", () => {
  const sql = readFileSync("supabase/migrations/20260928183837_schedule_leveraged_paper_doors.sql", "utf8");
  it("schedules the four paper doors (entry both hours; DST-paired close), GET, never the live door", () => {
    expect((sql.match(/cron\.schedule\(/g) ?? []).length).toBe(12);
    for (const sym of ["soxl", "tqqq", "sqqq", "soxs"]) {
      expect(sql).toContain(`'/api/agents/${sym}/cron', '{}'::jsonb, 'GET', 58000`);
      expect(sql).toContain(`kairos-${sym}-entry`);
    }
    expect(sql).not.toContain("'/api/agents/leveraged-live");
    expect(sql).toMatch(/close-edt', '\d+ 20 \* 3-10 1-5'/);
    expect(sql).toMatch(/close-est', '\d+ 21 \* 11,12,1,2 1-5'/);
  });
});

describe("leveraged symbols stay out of the equity chart-pattern evidence", () => {
  it("research skips the pattern shadow write for the four sleeve symbols", () => {
    const research = readFileSync("lib/research-agent.ts", "utf8");
    const guard = research.indexOf("!LEVERAGED_SLEEVE_SYMBOLS.has(symbol.toUpperCase()) && isEntryCandidateLong");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(research.indexOf("detectConfirmedDoubleReversal(candles)"));
  });
});

describe("leveraged symbols stay out of the rotation edge evidence", () => {
  it("loadRotationScoreEdgeEvidence skips the four sleeve symbols", () => {
    const src = readFileSync("lib/trading/capital-rotation.ts", "utf8");
    expect(src).toContain('LEVERAGED_SLEEVE_SYMBOLS.has(String(row.symbol ?? "").toUpperCase())');
    expect(src).toContain('from "./leveraged-sleeve-risk"');
  });
});
