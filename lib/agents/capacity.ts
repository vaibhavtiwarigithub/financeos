export type AgentCapacityRow = {
  agent: string;
  workloadType: "queue" | "eligible_work" | "scheduled_workload" | "no_queue";
  pending: number | null;
  staged: number | null;
  observedPerDay: number | null;
  configuredCeiling: number | null;
  estimatedClearDays: number | null;
  oldestHours: number | null;
  nextAction: string;
  estimateBasis: string;
};

export function median(values: number[]): number | null {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

export function estimatedClearDays(backlog: number | null, daily: number | null): number | null {
  if (backlog == null || daily == null || daily <= 0) return null;
  return Math.ceil(backlog / daily);
}

export async function loadAgentCapacity(svc: any, market: "us" | "india"): Promise<AgentCapacityRow[]> {
  const configuredResearchCap = market === "india"
    ? Number.parseInt(process.env.RESEARCH_INDIA_CANDIDATE_CAP ?? "8", 10)
    : Number.parseInt(process.env.RESEARCH_CANDIDATE_CAP ?? "40", 10);

  const [queueResult, stagedResult, researchRunsResult, pendingSignalsResult, positionsResult] = await Promise.all([
    svc.from("research_queue").select("symbol, deferred_at").eq("market", market),
    svc.from("agent_signals").select("symbol", { count: "exact", head: true })
      .eq("market", market).eq("status", "weekend_staged"),
    svc.from("agent_runs").select("signals_written, workload_metrics, started_at")
      .eq("market", market).eq("agent_type", "research").eq("status", "done")
      .order("started_at", { ascending: false }).limit(10),
    svc.from("agent_signals").select("id", { count: "exact", head: true })
      .eq("market", market).eq("status", "pending").eq("direction", "long")
      .eq("score_source", "deterministic_v1").eq("session_validated", true),
    svc.from("paper_positions").select("id", { count: "exact", head: true })
      .eq("market", market),
  ]);

  const queueRows = queueResult.error ? null : (queueResult.data ?? []);
  const staged = stagedResult.error ? null : Number(stagedResult.count ?? 0);
  const queueTotal = queueRows == null ? null : queueRows.length;
  const unprepared = queueTotal == null || staged == null ? null : Math.max(0, queueTotal - staged);
  const oldestMs = queueRows && queueRows.length > 0
    ? Math.min(...queueRows.map((row: any) => Date.parse(String(row.deferred_at))).filter(Number.isFinite))
    : null;
  const oldestHours = oldestMs == null ? null : Math.max(0, (Date.now() - oldestMs) / 3_600_000);

  const recentRuns: any[] = researchRunsResult.error ? [] : (researchRunsResult.data ?? []);
  const candidateCounts = recentRuns
    .map((run) => Number(run.workload_metrics?.candidate_processed))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const fallbackCounts = recentRuns
    .map((run) => Number(run.signals_written))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const observed = median(candidateCounts.length > 0 ? candidateCounts : fallbackCounts);
  const observedPerDay = observed == null ? null : Math.max(0, Math.floor(observed));
  const cap = Number.isFinite(configuredResearchCap) ? Math.max(1, configuredResearchCap) : null;
  const effectiveCapacity = observedPerDay && cap ? Math.min(observedPerDay, cap) : observedPerDay ?? cap;

  const pendingPaper = pendingSignalsResult.error ? null : Number(pendingSignalsResult.count ?? 0);
  const openPositions = positionsResult.error ? null : Number(positionsResult.count ?? 0);

  return [
    {
      agent: "ResearchAgent",
      workloadType: "queue",
      pending: unprepared,
      staged,
      observedPerDay,
      configuredCeiling: cap,
      estimatedClearDays: estimatedClearDays(queueTotal, effectiveCapacity),
      oldestHours,
      nextAction: "Market closed day: stage queued symbols. Next market session: re-score staged symbols and release only fresh validated decisions.",
      estimateBasis: candidateCounts.length > 0
        ? "Median candidate_processed from the latest 10 completed market runs."
        : "Fallback median total signals from recent runs; includes holdings until structured metrics accumulate.",
    },
    {
      agent: "PaperTrader",
      workloadType: "eligible_work",
      pending: pendingPaper,
      staged: null,
      observedPerDay: null,
      configuredCeiling: 10,
      estimatedClearDays: pendingPaper == null ? null : pendingPaper === 0 ? 0 : 1,
      oldestHours: null,
      nextAction: "At the market's scheduled paper run, evaluate fresh validated longs through all entry and portfolio gates.",
      estimateBasis: "Current eligible signal count; 10 is the route selection ceiling, not a fill promise.",
    },
    {
      agent: "PositionMonitor",
      workloadType: "scheduled_workload",
      pending: openPositions,
      staged: null,
      observedPerDay: openPositions,
      configuredCeiling: null,
      estimatedClearDays: openPositions == null ? null : openPositions === 0 ? 0 : 1,
      oldestHours: null,
      nextAction: "Checks every open paper position after the market session; exits remain subject to price and score freshness rules.",
      estimateBasis: "Open positions are a per-run workload, not a durable queue.",
    },
    {
      agent: "LearnerAgent",
      workloadType: "no_queue",
      pending: null,
      staged: null,
      observedPerDay: null,
      configuredCeiling: null,
      estimatedClearDays: null,
      oldestHours: null,
      nextAction: "Runs its governed weekly evaluation over eligible matured observations.",
      estimateBasis: "No honest item queue exists; performance gates are sample-based rather than throughput-based.",
    },
  ];
}
