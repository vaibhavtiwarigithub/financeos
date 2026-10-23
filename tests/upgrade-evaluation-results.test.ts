import { describe, expect, it } from "vitest";
import { loadStoredShadowEvaluations, evaluationCellDescription } from "@/lib/shadows/evaluation-results";

function service(error?: string, tooMany = false) {
  const queries: Array<{ table: string; filters: Record<string, unknown>; columns: string }> = [];
  const svc = { from(table: string) {
    const request = { table, filters: {} as Record<string, unknown>, columns: "" }; queries.push(request);
    const q: any = { select(c: string) { request.columns = c; return q; }, eq(k: string, v: unknown) { request.filters[k] = v; return q; }, order() { return q; }, limit() { return q; },
      then(resolve: (value: unknown) => unknown) {
        return Promise.resolve(error ? { data: null, error: { message: error } } : { error: null, data: request.columns.includes("evaluation_batch_id")
          ? [{ evaluation_batch_id: `${table}-${request.filters.market ?? "india"}`, evaluated_at: new Date().toISOString() }]
          : Array.from({ length: tooMany ? 1000 : 1 }, () => ({ horizon_days: 10, classification: "insufficient_evidence", mean_session_rank_ic: 0.1, t_stat: null, qualifying_sessions: 3 })) }).then(resolve);
      } };
    return q;
  } };
  return { svc, queries };
}
describe("existing evaluator result projection", () => {
  it("pins market, variant set and batch before reading results; no provider or write methods exist", async () => {
    const { svc, queries } = service(); const results = await loadStoredShadowEvaluations(svc, "us");
    expect(results).toHaveLength(3);
    expect(results.every(r => r.cells[0].classification === "insufficient_evidence")).toBe(true);
    expect(queries.every(q => q.filters.market === "us")).toBe(true);
    expect(queries.filter(q => !q.columns.includes("evaluation_batch_id")).every(q => q.filters.evaluation_batch_id)).toBe(true);
    expect(queries.filter(q => q.table === "score_variant_eval_runs").map(q => q.filters.variant_set)).toEqual(["variant_set_v1", "insider_v2", "variant_set_v1", "insider_v2"]);
  });
  it("includes India-only event evaluation without fabricating a market column", async () => {
    const { svc, queries } = service(); const results = await loadStoredShadowEvaluations(svc, "india");
    expect(results).toHaveLength(3);
    expect(results.some(r => r.id === "insider-v2-shadow")).toBe(false);
    expect(queries.filter(q => q.table === "llm_event_ic_runs").every(q => q.filters.market === undefined)).toBe(true);
  });
  it("surfaces read and cap failures, not zero valid evidence", async () => {
    expect((await loadStoredShadowEvaluations(service("Read failed").svc, "us")).every(r => r.error === "Read failed")).toBe(true);
    expect((await loadStoredShadowEvaluations(service(undefined, true).svc, "us")).every(r => r.error?.includes("bounded view"))).toBe(true);
  });
  it("keeps withheld t-stat unavailable and labels descriptive metrics, without averaging cohorts", () => {
    const description = evaluationCellDescription({ horizon_days: 10, series_key: "model:exact-version:initial", cohort_key: "near_threshold", qualifying_sessions: 3, mean_session_rank_ic: -0.12, t_stat: null, classification: "insufficient_evidence" });
    expect(description).toContain("near_threshold: insufficient_evidence");
    expect(description).toContain("IC -0.120; t unavailable");
  });
  it("does not let a fresh source table hide an old evaluator", async () => {
    const results = await loadStoredShadowEvaluations(service().svc, "us", Date.now() + 120 * 3_600_000);
    expect(results.every(r => r.error?.includes("older than"))).toBe(true);
  });
});
