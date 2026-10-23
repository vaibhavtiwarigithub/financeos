// Read existing evaluator outputs; never run an evaluation or infer adoption from IC.
const CONTRACTS = {
  "llm-council-shadow": { table: "llm_council_ic_runs", filters: {}, columns: "horizon_days,series_key,cohort_key,qualifying_sessions,mean_session_rank_ic,t_stat,classification,reason", section: "council-evidence" },
  "score-variants-forward-shadow": { table: "score_variant_eval_runs", filters: { variant_set: "variant_set_v1" }, columns: "variant_id,sample,horizon_days,sessions,variant_mean_ic,variant_ic_t,paired_spread_delta,meets_adoption_gate,classification,reason", section: "formula-evidence" },
  "insider-v2-shadow": { table: "score_variant_eval_runs", filters: { variant_set: "insider_v2" }, columns: "variant_id,sample,horizon_days,sessions,variant_mean_ic,variant_ic_t,paired_spread_delta,meets_adoption_gate,classification,reason", section: "formula-evidence" },
  "llm-event-extraction": { table: "llm_event_ic_runs", filters: {}, columns: "horizon_days,series_key,qualifying_sessions,mean_session_rank_ic,t_stat,classification,reason", section: "market-evidence" },
} as const;
export interface StoredEvaluation {
  id: string; evaluatedAt: string | null; batchId: string | null;
  cells: any[]; error: string | null; href: string;
}

export async function loadStoredShadowEvaluations(svc: any, market: "us" | "india", nowMs = Date.now()): Promise<StoredEvaluation[]> {
  return Promise.all(Object.entries(CONTRACTS).filter(([id]) => (market === "india" || id !== "llm-event-extraction") && (market === "us" || id !== "insider-v2-shadow")).map(async ([id, contract]) => {
    const base = { id, href: `/dashboard/learning#${contract.section}`, cells: [] as any[], evaluatedAt: null, batchId: null };
    const filter = (q: any) => {
      // The event evaluator is India-only and has no market column.
      if (id !== "llm-event-extraction") q = q.eq("market", market);
      for (const [key, value] of Object.entries(contract.filters)) q = q.eq(key, value);
      return q;
    };
    const latest = await filter(svc.from(contract.table).select("evaluation_batch_id,evaluated_at")).order("evaluated_at", { ascending: false }).limit(1);
    if (latest.error) return { ...base, error: latest.error.message };
    const batch = latest.data?.[0];
    if (!batch) return { ...base, error: null };
    const maxHours = id === "llm-council-shadow" ? 96 : 72;
    const evaluatedMs = Date.parse(batch.evaluated_at);
    const stale = !Number.isFinite(evaluatedMs) || nowMs - evaluatedMs > maxHours * 3_600_000;
    const rows = await filter(svc.from(contract.table).select(contract.columns)).eq("evaluation_batch_id", batch.evaluation_batch_id).limit(1000);
    return { ...base, evaluatedAt: batch.evaluated_at, batchId: batch.evaluation_batch_id,
      cells: rows.error ? [] : rows.data ?? [],
      error: rows.error?.message ?? ((rows.data?.length ?? 0) >= 1000 ? "Evaluation batch exceeds bounded view; use the full evaluator report." : !rows.data?.length ? "Latest evaluation batch has no stored cells for its declared market and set." : stale ? `Latest evaluator batch is invalid or older than ${maxHours}h; inspect the scheduled evaluator.` : null),
    };
  }));
}

export function evaluationCellDescription(cell: any): string {
  const ic = cell.mean_session_rank_ic ?? cell.variant_mean_ic;
  const t = cell.t_stat ?? cell.variant_ic_t;
  const number = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? n.toFixed(3) : "unavailable";
  return `h${cell.horizon_days} · ${cell.series_key ?? cell.variant_id} · ${cell.cohort_key ?? cell.sample ?? "declared cohort"}: ${cell.classification}; ${cell.qualifying_sessions ?? cell.sessions ?? 0} qualifying sessions; IC ${number(ic)}; t ${number(t)}. ${cell.reason ?? ""}`;
}
