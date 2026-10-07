export interface RotationStatus {
  market: "us" | "india";
  /** Database paper-execution flag only. NOT proof the executor can run; see `executor`. */
  executionEnabled: boolean;
  /** The three independent keys the executor requires before it reads the book. */
  keys: { dbExecuteFlag: boolean; deploymentGate: boolean; scoreOnlyAllowed: boolean };
  executor: RotationExecutorState;
  /** True only if every live-book execution/proposal flag is false. */
  liveRotationOff: boolean;
  paperExecutedCount: number;
  latestP1Ready: boolean | null;
  latestBlockers: string[];
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
  /** Owner-only projection of recent paper events. Empty for aggregate callers. */
  activity: RotationActivityEvent[];
}

export interface RotationActivityEvent {
  id: string;
  createdAt: string;
  status: string;
  candidateSymbol: string;
  sourceSymbol: string | null;
  candidateScore: number | null;
  sourceScore: number | null;
  scoreEdge: number | null;
  buyNotional: number | null;
  sellNotional: number | null;
  turnoverConsumed: number | null;
  reason: string | null;
  p1Ready: boolean | null;
  p1ContractRecorded: boolean;
  blockers: string[];
  persistencePriorRuns: number | null;
  persistenceRequiredPriorRuns: number | null;
  monthlyTurnoverUsedPct: number | null;
  proposedTurnoverPct: number | null;
  exactTaxLot: Record<string, unknown> | null;
  scoreToReturn: Record<string, unknown> | null;
  postSwapAllowed: boolean | null;
  candidateCorrelation: Record<string, unknown> | null;
  postSwapAdjustments: string[];
}

export type RotationExecutorState =
  | "disabled"        // DB paper flag off
  | "keys_missing"    // DB flag on but another key (deployment gate / score-only owner key) is closed: cannot run
  | "armed_blocked"   // every key open; the latest P1 readiness contract still has blockers
  | "armed_ready";    // every key open and the latest shadow passed P1 (an eligible swap may execute)

/** Pure so the enabled-switch vs executable-rotation distinction is testable. */
export function describeRotationExecutor(input: {
  dbExecuteFlag: boolean; deploymentGate: boolean; scoreOnlyAllowed: boolean; latestP1Ready: boolean | null;
}): RotationExecutorState {
  if (!input.dbExecuteFlag) return "disabled";
  if (!input.deploymentGate || !input.scoreOnlyAllowed) return "keys_missing";
  return input.latestP1Ready === true ? "armed_ready" : "armed_blocked";
}

export async function loadRotationStatus(supabase: any, market: "us" | "india", includeActivity = false): Promise<RotationStatus> {
  const eventColumns = includeActivity
    ? "id,created_at,status,candidate_symbol,source_symbol,candidate_score,source_score,score_edge,buy_notional,sell_notional,turnover_consumed,gate_results_json,audit_json"
    : "created_at,status,gate_results_json,audit_json";
  const [eventsResult, configResult, mandateResult] = await Promise.all([
    supabase.from("rotation_events")
      .select(eventColumns)
      .eq("market", market).eq("book_type", "paper")
      .order("created_at", { ascending: false }).limit(250),
    supabase.from("rotation_config")
      .select("book_type,rotation_shadow_enabled,rotation_paper_execute_enabled,rotation_allow_score_only_paper,rotation_live_proposals_enabled")
      .eq("market", market),
    supabase.from("investment_mandates")
      .select("turnover_budget_monthly,tax_sensitivity")
      .eq("market", market).eq("active", true)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (eventsResult.error) throw new Error(`rotation event read failed (${market}): ${eventsResult.error.message}`);
  if (configResult.error) throw new Error(`rotation config read failed (${market}): ${configResult.error.message}`);
  if (mandateResult.error) throw new Error(`rotation mandate read failed (${market}): ${mandateResult.error.message}`);

  const events = eventsResult.data ?? [];
  const configRows = (configResult.data ?? []) as any[];
  const paperConfig = configRows.find(row => row.book_type === "paper") ?? null;
  const liveConfig = configRows.find(row => row.book_type === "live") ?? null;
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

  const latest = (events as any[])[0];
  const latestGate = latest?.gate_results_json && typeof latest.gate_results_json === "object" ? latest.gate_results_json : {};
  const latestP1Ready: boolean | null = latest == null ? null : latestGate.p1_ready === true || latest.audit_json?.p1_ready === true;
  const latestBlockers: string[] = Array.isArray(latestGate.p1_blockers) ? latestGate.p1_blockers.map(String) : [];
  const keys = {
    dbExecuteFlag: paperConfig?.rotation_paper_execute_enabled === true,
    // Read in the running deployment, so this reports the effective value without exposing it.
    deploymentGate: process.env.CAPITAL_ROTATION_PAPER_ENABLED === "true",
    scoreOnlyAllowed: paperConfig?.rotation_allow_score_only_paper === true,
  };
  const liveRotationOff = configRows.length > 0
    && liveConfig?.rotation_paper_execute_enabled !== true && liveConfig?.rotation_live_proposals_enabled !== true
    && paperConfig?.rotation_live_proposals_enabled !== true;
  const turnoverBudget = (mandateResult.data as any)?.turnover_budget_monthly;
  const state = events.length === 0 ? "no_evidence" : p1ReadyCount > 0 ? "accumulating" : "blocked";
  const executorState = describeRotationExecutor({ ...keys, latestP1Ready });
  const missingKeys = [
    !keys.deploymentGate ? "deployment gate CAPITAL_ROTATION_PAPER_ENABLED" : null,
    !keys.scoreOnlyAllowed ? "owner score-only key rotation_allow_score_only_paper" : null,
  ].filter(Boolean).join(" and ");
  const nextAction = executorState === "keys_missing"
    ? `Executor is inert: ${missingKeys} is closed, so no swap can run even if P1 evidence passes. Open it only as an owner decision after the evidence gates pass.`
    : events.length === 0
    ? "Wait for a full-book candidate to reach the funding gate; shadow evaluation runs automatically."
    : incompleteLegacyCount === events.length
      ? "New shadow runs will collect the completed readiness contract; existing rows predate it."
      : turnoverBudget == null
        ? "Keep execution off. The mandate grants zero rotation turnover until an owner-approved budget exists."
      : "Keep collecting independent market-session runs and resolve every repeated blocker before P1 review.";

  const activity: RotationActivityEvent[] = includeActivity ? (events as any[]).slice(0, 100).map(event => {
    const gate = event.gate_results_json && typeof event.gate_results_json === "object" ? event.gate_results_json : {};
    const audit = event.audit_json && typeof event.audit_json === "object" ? event.audit_json : {};
    const rawBlockers = Array.isArray(gate.p1_blockers)
      ? gate.p1_blockers : Array.isArray(audit.p1_blockers) ? audit.p1_blockers : null;
    const objectValue = (value: unknown): Record<string, unknown> | null =>
      value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const numberValue = (value: unknown): number | null => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
    return {
      id: String(event.id),
      createdAt: String(event.created_at),
      status: String(event.status ?? "unknown"),
      candidateSymbol: String(event.candidate_symbol ?? "—"),
      sourceSymbol: event.source_symbol == null ? null : String(event.source_symbol),
      candidateScore: numberValue(event.candidate_score),
      sourceScore: numberValue(event.source_score),
      scoreEdge: numberValue(event.score_edge),
      buyNotional: numberValue(event.buy_notional),
      sellNotional: numberValue(event.sell_notional),
      turnoverConsumed: numberValue(event.turnover_consumed),
      reason: typeof audit.reason === "string" ? audit.reason : null,
      p1Ready: typeof gate.p1_ready === "boolean" ? gate.p1_ready
        : typeof audit.p1_ready === "boolean" ? audit.p1_ready : null,
      p1ContractRecorded: rawBlockers != null,
      blockers: rawBlockers?.map(String) ?? [],
      persistencePriorRuns: numberValue(gate.persistence_prior_runs),
      persistenceRequiredPriorRuns: numberValue(gate.persistence_required_prior_runs),
      monthlyTurnoverUsedPct: numberValue(gate.monthly_turnover_used_pct),
      proposedTurnoverPct: numberValue(gate.proposed_turnover_pct),
      exactTaxLot: objectValue(gate.exact_tax_lot),
      scoreToReturn: objectValue(gate.score_to_return_mapping),
      postSwapAllowed: typeof gate.post_swap_allowed === "boolean" ? gate.post_swap_allowed : null,
      candidateCorrelation: objectValue(gate.candidate_correlation),
      postSwapAdjustments: Array.isArray(gate.post_swap_adjustments) ? gate.post_swap_adjustments.map(String) : [],
    };
  }) : [];

  return {
    market,
    executionEnabled: keys.dbExecuteFlag,
    keys,
    executor: executorState,
    liveRotationOff,
    paperExecutedCount: (events as any[]).filter(event => event.status === "paper_executed").length,
    latestP1Ready,
    latestBlockers,
    shadowEnabled: paperConfig?.rotation_shadow_enabled !== false,
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
    activity,
  };
}
