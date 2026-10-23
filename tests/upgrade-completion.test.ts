import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyCollectionEvidence, assessCompletion, summarizeCompletion } from "@/lib/shadows/completion";
import { SHADOW_PROGRAMS } from "@/lib/shadows/registry";
import { SHADOW_EVIDENCE_PROBES, evaluateShadowLiveness } from "@/lib/shadows/liveness";
import { summarizeAttribution } from "@/lib/shadows/summary";
import type { ShadowProgramStatus } from "@/lib/shadows/status";

const now = new Date("2026-10-23T14:00:00Z");
function program(overrides: Partial<ShadowProgramStatus> = {}): ShadowProgramStatus {
  return { ...SHADOW_PROGRAMS.find(p => p.id === "llm-council-shadow")!,
    available: true, lifecycle: "idle", blockers: ["Status adapter unavailable."], details: [], schedules: [], nextAction: "Read evaluator",
    progress: { completed: 0, target: null }, attribution: { comparisonType: "operational_only", state: "not_attributable", reason: "Operational only" },
    ...overrides,
  } as ShadowProgramStatus;
}
const source = { id: "llm-council-shadow", market: "us", verdict: "live", rows: 1369, last_write: now.toISOString(), note: "Fresh source" };

describe("Upgrade Path completion contract", () => {
  it("shows real collection when a presentation adapter is missing, without inventing a pass", () => {
    const p = applyCollectionEvidence(program(), source);
    expect(p.available).toBe(true); expect(p.lifecycle).toBe("collecting");
    expect(p.progress.completed).toBe(1369); expect(p.progress.target).toBeNull();
    const a = assessCompletion(p, source, now);
    expect(a.state).toBe("build_comparison"); expect(a.canEnable).toBe(false);
    expect(a.title).toBe("Connect the existing evaluator");
  });
  it.each(["unknown", "frozen", "empty", "failed_schedule_run", "stale_schedule_run"])("prioritizes %s evidence failures over results", verdict => {
    const s = { ...source, verdict, note: "Repair this exact failure" };
    const p = applyCollectionEvidence(program(), s);
    expect(assessCompletion(p, s, now)).toMatchObject({ state: "repair", priority: 0, reason: s.note, canEnable: false });
  });
  it("does not overwrite a real assessment with a row count", () => {
    const p = program({ blockers: ["Need mature labels"], lifecycle: "collecting" });
    expect(applyCollectionEvidence(p, source)).toBe(p);
    expect(assessCompletion(p, source, now).state).toBe("collecting");
  });
  it("does not leave unfinished qualification programs collecting forever", () => {
    expect(assessCompletion(program({ id: "exogenous-risk", lifecycle: "collecting", blockers: ["No regime evaluator"] }), source, now).state).toBe("build_comparison");
  });
  it("does not label a missing comparison as collecting or deploy-ready", () => {
    const p = program({ lifecycle: "ready_for_review", attribution: { comparisonType: "matched_replay", state: "producer_missing", reason: "No sized baseline/variant replay" } as any });
    expect(assessCompletion(p, source, now)).toMatchObject({ state: "build_comparison", reason: "No sized baseline/variant replay", canEnable: false });
  });
  it("retains legitimate forward-book immaturity after snapshot overlay", () => {
    const p = program({ lifecycle: "collecting", attribution: { comparisonType: "matched_replay", state: "collecting", reason: "1/2 completed blocks" } as any });
    expect(assessCompletion(p, source, now)).toMatchObject({ state: "collecting", reason: "1/2 completed blocks" });
  });
  it("keeps synthetic measurement and analysis readiness separate from activation", () => {
    const p = program({ attribution: { comparisonType: "matched_replay", state: "measured", measurementScope: "synthetic_diagnostic", reason: "Synthetic two-ETF test" } as any });
    expect(assessCompletion(p, source, now)).toMatchObject({ state: "result_review", title: "Synthetic result · not Kairos portfolio", canEnable: false });
    expect(assessCompletion(program({ lifecycle: "ready_for_review", blockers: [] }), source, now).state).toBe("analysis_review");
  });
  it("excludes inapplicable paths from completion and attribution denominators", () => {
    const p = program({ lifecycle: "not_applicable", attribution: { comparisonType: "matched_replay", state: "producer_missing", reason: "US only" } as any });
    const completion = assessCompletion(p, undefined, now);
    expect(completion.state).toBe("not_applicable");
    expect(summarizeCompletion([{ ...p, completion }]).applicable).toBe(0);
    expect(summarizeAttribution([p]).performanceEligible).toBe(0);
  });
  it("parks intentionally disabled work and reports overdue review without auto-promoting", () => {
    expect(assessCompletion(program({ lifecycle: "off", reviewDate: "2026-10-15" }), undefined, now)).toMatchObject({ state: "parked", overdue: true, canEnable: false });
  });
  it("checks daily and weekly allocation jobs on their own cadence", () => {
    const p = SHADOW_PROGRAMS.find(p => p.id === "international-allocation")!;
    const input = { program: p, market: "us" as const, probe: SHADOW_EVIDENCE_PROBES[p.id], nowMs: now.getTime(), count: 23, lastWrite: "2026-10-22T23:45:00Z",
      cronRows: p.cronJobs.map(jobname => ({ jobname, schedule: "", active: true, last_status: "succeeded", last_started_at: jobname.endsWith("shadow") ? "2026-10-19T03:30:00Z" : "2026-10-22T23:45:00Z" })) };
    expect(evaluateShadowLiveness(input).verdict).toBe("live");
    input.cronRows[1].last_started_at = "2026-10-18T00:00:00Z";
    expect(evaluateShadowLiveness(input).verdict).toBe("stale_schedule_run");
  });
  it("has a bounded geometry read and a separately aggregated, server-only all-horizon summary", () => {
    const sql = readFileSync("supabase/migrations/20261023135524_upgrade_path_label_coverage_summary.sql", "utf8");
    expect(sql).toContain("security invoker set search_path = ''");
    expect(sql).toContain("from public,anon,authenticated");
    expect(sql).toContain("to service_role"); expect(sql).toContain("l.matured_at<=now()");
    expect(sql).toContain("d.decision_context in ('entry_candidate','holding_review')");
    expect(sql).toContain("d.direction='long'"); expect(sql).not.toContain("'holding',");
    const status = readFileSync("lib/shadows/status.ts", "utf8");
    expect(status).toContain('.eq("horizon_days", PRIMARY_HORIZON_DAYS)');
    expect(status).toContain('svc.rpc("get_upgrade_path_label_coverage", { p_market: market })');
    const optimized = readFileSync("supabase/migrations/20261023142528_upgrade_path_label_summary_query_plan.sql", "utf8");
    expect(optimized).toContain("return query execute $coverage$");
    expect(optimized).toContain("$coverage$ using p_market");
    expect(optimized).toContain("security invoker set search_path = ''");
    expect(optimized).not.toContain("statement_timeout");
    const indexes = readFileSync("supabase/migrations/20261023143422_upgrade_path_label_read_indexes.sql", "utf8");
    expect(indexes).toContain("(matured_at desc)");
    expect(indexes).toContain("(horizon_days, id)");
    const page = readFileSync("components/dashboard/UpgradePathPage.tsx", "utf8");
    expect(page).toContain("if (inFlight.current?.market === market) return");
    expect(page).toContain("inFlight.current?.sequence === sequence");
    expect(page).toContain("disabled={loading} aria-busy={loading}");
  });
});
