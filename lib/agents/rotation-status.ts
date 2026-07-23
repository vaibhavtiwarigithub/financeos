export interface RotationStatus {
  market: "us" | "india";
  executionEnabled: boolean;
  shadowEnabled: boolean;
  eventCount: number;
  plannedCount: number;
  distinctRuns: number;
  latestAt: string | null;
  p1ReadyCount: number;
  incompleteLegacyCount: number;
  turnoverBudgetMonthlyPct: number | null;
  taxSensitivity: string;
  blockerCounts: Array<{ blocker: string; count: number }>;
  state: "no_evidence" | "accumulating" | "blocked";
  nextAction: string;
}

export async function loadRotationStatus(supabase: any, market: "us" | "india"): Promise<RotationStatus> {
  const [eventsResult, configResult, mandateResult] = await Promise.all([
    supabase.from("rotation_events")
      .select("created_at,status,gate_results_json,audit_json")
      .eq("market", market).eq("book_type", "paper")
      .order("created_at", { ascending: false }).limit(250),
    supabase.from("rotation_config")
      .select("rotation_shadow_enabled,rotation_paper_execute_enabled")
      .eq("market", market).eq("book_type", "paper").maybeSingle(),
    supabase.from("investment_mandates")
      .select("turnover_budget_monthly,tax_sensitivity")
      .eq("market", market).eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (eventsResult.error) throw new Error(`rotation event read failed (${market}): ${eventsResult.error.message}`);
  if (configResult.error) throw new Error(`rotation config read failed (${market}): ${configResult.error.message}`);
  if (mandateResult.error) throw new Error(`rotation mandate read failed (${market}): ${mandateResult.error.message}`);

  const events = eventsResult.data ?? [];
  const blockers = new Map<string, number>();
  const runs = new Set<string>();
  let p1ReadyCount = 0;
  let incompleteLegacyCount = 0;
  for (const event of events as any[]) {
    const gateJson = event.gate_results_json && typeof event.gate_results_json === "object" ? event.gate_results_json : {};
    const auditJson = event.audit_json && typeof event.audit_json === "object" ? event.audit_json : {};
    const runId = String(auditJson.run_id ?? "");
    if (runId) runs.add(runId);
    if (gateJson.p1_ready === true || auditJson.p1_ready === true) p1ReadyCount += 1;
    const rowBlockers = Array.isArray(gateJson.p1_blockers)
      ? gateJson.p1_blockers
      : Array.isArray(auditJson.p1_blockers) ? auditJson.p1_blockers : null;
    if (rowBlockers == null) incompleteLegacyCount += 1;
    else for (const blocker of rowBlockers) {
      const key = String(blocker);
      blockers.set(key, (blockers.get(key) ?? 0) + 1);
    }
  }

  const turnoverBudget = (mandateResult.data as any)?.turnover_budget_monthly;
  const state = events.length === 0 ? "no_evidence" : p1ReadyCount > 0 ? "accumulating" : "blocked";
  const nextAction = events.length === 0
    ? "Wait for a full-book candidate to reach the funding gate; shadow evaluation runs automatically."
    : incompleteLegacyCount === events.length
      ? "New shadow runs will collect the completed readiness contract; existing rows predate it."
      : turnoverBudget == null
        ? "Keep execution off. The mandate grants zero rotation turnover until an owner-approved budget exists."
        : "Keep collecting independent market-session runs and resolve every repeated blocker before P1 review.";

  return {
    market,
    executionEnabled: (configResult.data as any)?.rotation_paper_execute_enabled === true,
    shadowEnabled: (configResult.data as any)?.rotation_shadow_enabled !== false,
    eventCount: events.length,
    plannedCount: events.filter((event: any) => event.status === "planned").length,
    distinctRuns: runs.size,
    latestAt: events[0]?.created_at ?? null,
    p1ReadyCount,
    incompleteLegacyCount,
    turnoverBudgetMonthlyPct: turnoverBudget == null ? null : Number(turnoverBudget),
    taxSensitivity: String((mandateResult.data as any)?.tax_sensitivity ?? "medium"),
    blockerCounts: [...blockers.entries()].map(([blocker, count]) => ({ blocker, count })).sort((a, b) => b.count - a.count || a.blocker.localeCompare(b.blocker)),
    state,
    nextAction,
  };
}
