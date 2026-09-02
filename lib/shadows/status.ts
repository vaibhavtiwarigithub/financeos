import {
  SHADOW_PROGRAMS,
  type BenefitVerdict,
  type CallAccountingMode,
  type ShadowLifecycle,
  type ShadowProgramDefinition,
} from "@/lib/shadows/registry";
import {
  bindingCoverage,
  coverageBlockers,
  coverageByHorizon,
  MIN_DISTINCT_DATES,
  PRIMARY_HORIZON_DAYS,
  type LabelRow,
} from "@/lib/shadows/label-coverage";

export interface ShadowCallMetrics {
  mode: CallAccountingMode;
  recorded: number | null;
  networkAttempts: number | null;
  cacheHits: number | null;
  note: string;
}

export interface ShadowProgress {
  completed: number;
  target: number | null;
  unit: string;
  secondary?: { completed: number; target: number; unit: string } | null;
  windowDays: number;
  ratePerDay: number | null;
  estimatedDays: number | null;
}

export type ProgramRuntimeState =
  | "production_measurement"
  | "production_paper"
  | "production_blocked"
  | "scheduled_idle"
  | "deployed_inactive"
  | "not_applicable"
  | "status_unavailable";

export interface ProgramRuntimeDeployment {
  state: ProgramRuntimeState;
  summary: string;
  proof: string[];
  whyNotNextStage: string;
}

export interface ShadowProgramStatus extends ShadowProgramDefinition {
  lifecycle: ShadowLifecycle;
  benefitVerdict: BenefitVerdict;
  benefitEvidence: string;
  progress: ShadowProgress;
  calls: ShadowCallMetrics;
  schedules: Array<{ job: string; schedule: string | null; active: boolean }>;
  latestAt: string | null;
  blockers: string[];
  nextAction: string;
  details: string[];
  available: boolean;
  deployment: ProgramRuntimeDeployment;
}

type QueryResult<T> = { data: T | null; count?: number | null; error: { message?: string } | null };
export type ShadowMarket = "us" | "india";

function daysEstimate(completed: number, target: number | null, ratePerDay: number | null): number | null {
  if (target == null || completed >= target || ratePerDay == null || ratePerDay <= 0) return null;
  return Math.ceil((target - completed) / ratePerDay);
}

function progress(
  completed: number,
  target: number | null,
  unit: string,
  windowDays: number,
  secondary?: ShadowProgress["secondary"],
): ShadowProgress {
  const rate = windowDays > 0 ? completed / windowDays : null;
  return {
    completed,
    target,
    unit,
    secondary,
    windowDays,
    ratePerDay: rate,
    estimatedDays: daysEstimate(completed, target, rate),
  };
}

function calls(mode: CallAccountingMode, note: string, recorded: number | null = null, networkAttempts: number | null = null, cacheHits: number | null = null): ShadowCallMetrics {
  return { mode, note, recorded, networkAttempts, cacheHits };
}

function base(program: ShadowProgramDefinition): ShadowProgramStatus {
  return {
    ...program,
    lifecycle: "idle",
    benefitVerdict: "insufficient",
    benefitEvidence: "No trustworthy status could be derived.",
    progress: progress(0, null, "observations", 7),
    calls: calls(program.callAccounting, "Call accounting unavailable."),
    schedules: program.cronJobs.map((job) => ({ job, schedule: null, active: false })),
    latestAt: null,
    blockers: ["Status adapter unavailable."],
    nextAction: "Inspect the source ledger and System Health.",
    details: [],
    available: false,
    deployment: {
      state: "status_unavailable",
      summary: "Mainline implementation exists, but production runtime state could not be verified.",
      proof: [],
      whyNotNextStage: "Restore the status adapter before making a rollout decision.",
    },
  };
}

function deploymentFor(status: ShadowProgramStatus): ProgramRuntimeDeployment {
  const activeSchedules = status.schedules.filter((row) => row.active);
  const proof = [
    `Mainline ${status.mainline.enteredAt} at ${status.mainline.commit} (${status.mainline.implementationScope}).`,
    activeSchedules.length
      ? `Active production schedule(s): ${activeSchedules.map((row) => row.job).join(", ")}.`
      : "No active dedicated production schedule is registered for this market.",
    status.latestAt ? `Latest verified runtime evidence: ${status.latestAt}.` : "No runtime evidence timestamp is available.",
  ];

  if (!status.available) {
    return {
      state: "status_unavailable",
      summary: "The implementation is in mainline, but its production adapter failed; deployment/use must not be inferred.",
      proof,
      whyNotNextStage: "Repair the production status read before reviewing activation.",
    };
  }
  if (status.lifecycle === "not_applicable") {
    return {
      state: "not_applicable",
      summary: "The implementation is in the deployed app but intentionally does not apply to this market.",
      proof,
      whyNotNextStage: "No promotion is intended for this market.",
    };
  }
  if (status.lifecycle === "paper_active") {
    return {
      state: "production_paper",
      summary: "The implementation is deployed and currently allowed to affect the paper portfolio only.",
      proof,
      whyNotNextStage: status.blockers.join(" ") || "A separate live-stage review and owner decision are still required.",
    };
  }
  if (status.lifecycle === "blocked") {
    return {
      state: "production_blocked",
      summary: "The implementation is deployed, but a declared production evidence or correctness gate is currently blocked.",
      proof,
      whyNotNextStage: status.blockers.join(" ") || "Resolve the failed gate before any rollout review.",
    };
  }
  if (status.lifecycle === "collecting" || status.lifecycle === "ready_for_review" || status.lifecycle === "armed") {
    return {
      state: "production_measurement",
      summary: status.lifecycle === "ready_for_review"
        ? "The implementation is deployed for production measurement and its evidence floor is review-ready; it has not been promoted into a stronger influence stage."
        : status.lifecycle === "armed"
          ? "The implementation is deployed and armed, but is waiting for an eligible candidate; it has no scoring or money authority from that state alone."
          : "The implementation is deployed and currently collecting production evidence without exceeding its declared influence boundary.",
      proof,
      whyNotNextStage: status.blockers.join(" ") || "Readiness is advisory; promotion requires a separate governed decision.",
    };
  }
  if (status.lifecycle === "idle" && activeSchedules.length) {
    return {
      state: "scheduled_idle",
      summary: "The implementation and schedule are deployed, but the expected production evidence is not arriving.",
      proof,
      whyNotNextStage: status.blockers.join(" ") || "Investigate the idle schedule before promotion or removal.",
    };
  }
  return {
    state: "deployed_inactive",
    summary: status.mainline.implementationScope === "inert_scaffold"
      ? "An inert scaffold/catalog is in the deployed codebase; no production decision consumer is enabled."
      : "The implementation is in the deployed codebase but its runtime campaign or influence flag is off.",
    proof,
    whyNotNextStage: status.blockers.join(" ") || "No approved activation campaign exists.",
  };
}

async function loadLabelCoverageRows(svc: any, market: ShadowMarket): Promise<QueryResult<any[]>> {
  const pageSize = 1_000;
  const maxRows = 20_000;
  const rows: any[] = [];

  for (let from = 0; from < maxRows; from += pageSize) {
    const { data, error } = await svc.from("observation_labels")
      .select("horizon_days,fwd_return,decision_observations!inner(ts,symbol,market,entry_eligible)")
      .eq("decision_observations.market", market)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null };
  }

  return {
    data: null,
    error: { message: `Label coverage exceeds the bounded ${maxRows}-row read; paginate the aggregate server-side before trusting readiness.` },
  };
}

function latestIso(rows: any[], field: string): string | null {
  const values = rows.map((row) => row?.[field]).filter(Boolean).sort();
  return values.length ? values[values.length - 1] : null;
}

function scheduleFor(program: ShadowProgramDefinition, cronRows: any[], market: ShadowMarket): ShadowProgramStatus["schedules"] {
  const marketJobs = program.cronJobs.filter((job) => {
    const indiaJob = /(^|-)india($|-)/.test(job);
    const usJob = /(^|-)us($|-)/.test(job);
    return market === "india" ? indiaJob || (!indiaJob && !usJob) : usJob || (!indiaJob && !usJob);
  });
  return marketJobs.map((job) => {
    const row = cronRows.find((item) => item?.jobname === job);
    return { job, schedule: row?.schedule ?? null, active: row?.active === true };
  });
}

export async function getShadowProgramStatuses(svc: any, market: ShadowMarket): Promise<ShadowProgramStatus[]> {
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();
  const since45 = new Date(Date.now() - 45 * 86400_000).toISOString();
  const since90 = new Date(Date.now() - 90 * 86400_000).toISOString();

  const [
    cronRes,
    activePolicyRes,
    policyVersionsRes,
    evaluationRes,
    callLedgerRes,
    networkCallRes,
    cacheHitRes,
    degradationRes,
    shadowDecisionRes,
    edgeSignalRes,
    edgeReadinessRes,
    rotationConfigRes,
    rotationEventRes,
    paperTradeRes,
    earningsRiskRes,
    allocationPolicyRes,
    allocationAssessmentRes,
    strategyConfigRes,
    autonomousProposalRes,
    validationPolicyRes,
    shadowVersionRes,
    downsideConfigRes,
    downsideEventRes,
    indiaNewsCacheRes,
    indiaNewsLedgerRes,
    indiaNewsNetworkRes,
    indiaNewsHistoryRes,
    exogenousObservationRes,
    marketRegimeRunRes,
    fundamentalFactsRes,
    labelCoverageRes,
    dimensionDiagnosticRunRes,
    horizonExtensionRes,
    exitStopRunRes,
    archetypeIcRes,
    alphaDiagnosticRes,
  ] = await Promise.all([
    svc.rpc("get_shadow_cron_status"),
    svc.from("active_evidence_policy").select("market,policy_version_id").eq("market", market),
    svc.from("evidence_policy_versions").select("id,market,version,router_enabled,change_note").eq("market", market),
    svc.from("evidence_policy_evaluations")
      .select("market,passed,safety_pass,quality_pass,eligibility_flips,requires_owner_review,created_at,expires_at,market_session_date")
      .eq("market", market).gte("created_at", since45).order("created_at", { ascending: false }).limit(300),
    svc.from("provider_call_ledger")
      .select("id", { count: "exact", head: true })
      .eq("market", market).gte("created_at", since7).or("run_id.like.shadow:%,run_id.like.cohort:%"),
    svc.from("provider_call_ledger")
      .select("id", { count: "exact", head: true })
      .eq("market", market).gte("created_at", since7)
      .or("and(run_id.like.shadow:%,lease_outcome.neq.skipped),and(run_id.like.shadow:%,transport_status.not.is.null),and(run_id.like.cohort:%,lease_outcome.neq.skipped),and(run_id.like.cohort:%,transport_status.not.is.null)"),
    svc.from("provider_call_ledger")
      .select("id", { count: "exact", head: true })
      .eq("market", market).gte("created_at", since7)
      .or("run_id.like.shadow:%,run_id.like.cohort:%")
      .eq("cache_outcome", "fresh"),
    svc.from("evidence_degradation_events")
      .select("market,action,created_at").eq("market", market).gte("created_at", since7).limit(2000),
    svc.from("shadow_decisions")
      .select("market,setup_type,would_enter,ts,observation_id").eq("market", market).gte("ts", since7).limit(5000),
    svc.from("edge_signals")
      .select("market,edge_id,created_at", { count: "exact" })
      .eq("market", market)
      .gte("created_at", since7).order("created_at", { ascending: false }).limit(1000),
    svc.from("edge_readiness_status")
      .select("market,edge_id,horizon,windows_observed,windows_required,validation_windows_observed,validation_windows_required,stage,next_action,evaluated_at")
      .eq("market", market)
      .limit(200),
    svc.from("rotation_config")
      .select("market,book_type,rotation_shadow_enabled,rotation_paper_execute_enabled,rotation_live_proposals_enabled").eq("market", market),
    svc.from("rotation_events")
      .select("market,status,created_at,candidate_symbol,source_symbol").eq("market", market).gte("created_at", since45).limit(2000),
    svc.from("paper_trades")
      .select("market,exit_reason,realized_pnl,pnl_pct,closed_at").eq("market", market).eq("exit_reason", "capital_rotation").gte("closed_at", since90).limit(500),
    svc.from("earnings_risk_observations")
      .select("market,environment,decision_kind,report_date,options_quality,counterfactual_verdict,behavior_changed,created_at")
      .eq("market", market).gte("created_at", since90).limit(5000),
    svc.from("international_allocation_policies")
      .select("status,target_pct,deadband_pct,updated_at").order("updated_at", { ascending: false }).limit(5),
    svc.from("international_allocation_assessments")
      .select("assessment_status,proposed_action,created_at").gte("created_at", since90).limit(500),
    svc.from("strategy_config")
      .select("live_auto_enabled,live_auto_mode_us,live_auto_mode_india,allocation_enabled").limit(1).maybeSingle(),
    svc.from("trade_proposals")
      .select("market,status,execution_mode,created_at").eq("market", market).eq("execution_mode", "autonomous_shadow").gte("created_at", since45).limit(2000),
    svc.from("strategy_validation_automation")
      .select("market,enabled,auto_shadow_enabled,max_active_shadows,updated_at").eq("market", market),
    svc.from("strategy_versions")
      .select("id,market,state,created_at").eq("market", market).eq("state", "shadow_paper").limit(20),
    svc.from("downside_hedge_config")
      .select("market,enabled,paper_execute_enabled,updated_at").eq("market", market).limit(10),
    svc.from("downside_hedge_events")
      .select("created_at,event_type,decision").eq("market", market).gte("created_at", since90).limit(1000),
    market === "india"
      ? svc.from("evidence_cache_v2")
        .select("symbol,intent,quality_state,fetched_at")
        .eq("market", "india")
        .in("intent", ["sentiment.news_headlines_shadow", "event.corporate_announcement_shadow"])
        .gte("fetched_at", since45).limit(10000)
      : Promise.resolve({ data: [] as any[], error: null }),
    market === "india"
      ? svc.from("provider_call_ledger").select("id", { count: "exact", head: true })
        .eq("market", "india").gte("created_at", since7).like("run_id", "india-news-shadow:%")
      : Promise.resolve({ data: [] as any[], count: 0, error: null }),
    market === "india"
      ? svc.from("provider_call_ledger").select("id", { count: "exact", head: true })
        .eq("market", "india").gte("created_at", since7).like("run_id", "india-news-shadow:%")
        .eq("cache_outcome", "miss")
      : Promise.resolve({ data: [] as any[], count: 0, error: null }),
    market === "india"
      ? svc.from("provider_call_ledger").select("created_at")
        .eq("market", "india").gte("created_at", since45).like("run_id", "india-news-shadow:%")
        .eq("lease_outcome", "completed").limit(10000)
      : Promise.resolve({ data: [] as any[], error: null }),
    svc.from("exogenous_observations")
      .select("market,series_key,quality,available_at,created_at")
      .in("market", [market, "global"]).gte("created_at", since90).limit(5000),
    svc.from("market_regime_runs")
      .select("market,domestic_state,global_spillover_state,computed_at")
      .eq("market", market).gte("computed_at", since90).limit(500),
    svc.from("fundamental_facts")
      .select("symbol,source,filing_date,captured_at")
      .eq("market", market).gte("captured_at", since90).limit(10000),
    // Matured decision labels. The join is inner on purpose: an observation with
    // no label has not matured and must not count toward coverage.
    loadLabelCoverageRows(svc, market),
    svc.from("dimension_diagnostic_runs")
      .select("id,status,horizon_days,input_observation_count,distinct_session_count,created_at")
      .eq("market", market).gte("created_at", since45).order("created_at", { ascending: false }).limit(100),
    svc.from("horizon_extension_shadow")
      .select("market,evaluated_at,run_id,would_extend,reason")
      .eq("market", market).gte("evaluated_at", since90).order("evaluated_at", { ascending: false }).limit(10000),
    svc.from("exit_stop_shadow_runs")
      .select("market,as_of_date,horizon_days,status,created_at,n_rows,n_dates,effective_observations,mean_paired_diff,paired_diff_t")
      .eq("market", market).gte("created_at", since90).order("created_at", { ascending: false }).limit(500),
    svc.from("archetype_ic_runs")
      .select("market,created_at,as_of_date,horizon_days,cohort,setup_type")
      .eq("market", market).gte("created_at", since90).order("created_at", { ascending: false }).limit(1000),
    svc.from("backtest_experiments")
      .select("market,started_at,completed_at,created_at,experiment_type,result_summary")
      .eq("market", market).eq("experiment_type", "alpha_diagnostic").gte("created_at", since90).order("created_at", { ascending: false }).limit(100),
  ]) as Array<QueryResult<any>>;

  const cronRows = cronRes.data ?? [];
  const activePolicies = activePolicyRes.data ?? [];
  const policyVersions = policyVersionsRes.data ?? [];
  const evaluations = evaluationRes.data ?? [];
  const ledgerCount = callLedgerRes.count ?? 0;
  const degradation = degradationRes.data ?? [];
  const shadowDecisions = shadowDecisionRes.data ?? [];
  const edgeSignals = edgeSignalRes.data ?? [];
  const readiness = edgeReadinessRes.data ?? [];
  const rotationConfig = rotationConfigRes.data ?? [];
  const rotationEvents = rotationEventRes.data ?? [];
  const rotationTrades = paperTradeRes.data ?? [];
  const earnings = earningsRiskRes.data ?? [];
  const allocationPolicies = allocationPolicyRes.data ?? [];
  const allocationAssessments = allocationAssessmentRes.data ?? [];
  const strategyConfig = strategyConfigRes.data ?? null;
  const autonomousProposals = autonomousProposalRes.data ?? [];
  const validationPolicies = validationPolicyRes.data ?? [];
  const shadowVersions = shadowVersionRes.data ?? [];
  const downsideConfigs = downsideConfigRes.data ?? [];
  const downsideEvents = downsideEventRes.data ?? [];
  const indiaNewsRows = indiaNewsCacheRes.data ?? [];
  const indiaNewsHistory = indiaNewsHistoryRes.data ?? [];
  const exogenousObservations = exogenousObservationRes.data ?? [];
  const marketRegimeRuns = marketRegimeRunRes.data ?? [];
  const fundamentalFacts = fundamentalFactsRes.data ?? [];
  const diagnosticRuns = dimensionDiagnosticRunRes.data ?? [];
  const horizonExtensions = horizonExtensionRes.data ?? [];
  const exitStopRuns = exitStopRunRes.data ?? [];
  const archetypeRuns = archetypeIcRes.data ?? [];
  const alphaDiagnosticRuns = alphaDiagnosticRes.data ?? [];

  const labelRows: LabelRow[] = (labelCoverageRes.data ?? [])
    .map((row: any) => {
      const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      if (!decision?.ts || row.fwd_return == null) return null;
      return {
        date: String(decision.ts).slice(0, 10),
        symbol: String(decision.symbol ?? ""),
        horizonDays: Number(row.horizon_days),
        entryEligible: decision.entry_eligible === true,
      };
    })
    .filter((row: LabelRow | null): row is LabelRow => row != null && Number.isFinite(row.horizonDays));
  const labelCoverage = coverageByHorizon(labelRows);

  const statuses = SHADOW_PROGRAMS.map((program) => {
    const status = base(program);
    status.schedules = scheduleFor(program, cronRows, market);

    if (!program.markets.includes(market)) {
      status.lifecycle = "not_applicable";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${program.name} is not designed for the ${market === "india" ? "India" : "US"} pipeline.`;
      status.progress = progress(0, null, "not applicable", 0);
      status.calls = calls("not_applicable", "No provider calls are made for this market.");
      status.blockers = [];
      status.nextAction = "No action. This program is intentionally market-specific.";
      status.details = [];
      status.available = true;
      return status;
    }

    if (program.id === "exit-geometry") {
      // Readiness only. The counterfactual itself lives in
      // GET /api/agents/exit-geometry-shadow — running the geometry grid here
      // would mean a second heavy label read on every dashboard load, and this
      // program's job is to say WHEN the question becomes decidable.
      // Counted over ENTRY-ELIGIBLE rows only, matching what the shadow endpoint
      // actually analyses. Counting all labels would have opened this gate at
      // 7/20 while the usable cohort still had 2 dates — a gate that clears
      // before its own analysis is ready is worse than no gate.
      const atTradedHorizon = coverageByHorizon(labelRows.filter((row) => row.entryEligible))
        .find((row) => row.horizonDays === PRIMARY_HORIZON_DAYS);
      const dates = atTradedHorizon?.distinctDates ?? 0;
      const decidable = dates >= MIN_DISTINCT_DATES;

      status.lifecycle = !atTradedHorizon ? "idle" : decidable ? "ready_for_review" : "collecting";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = atTradedHorizon
        ? `${market.toUpperCase()}: ${atTradedHorizon.observations} matured ${PRIMARY_HORIZON_DAYS}-day labels across ${dates} decision date(s), ${atTradedHorizon.eligibleObservations} entry-eligible.`
        : `No matured ${PRIMARY_HORIZON_DAYS}-day labels for ${market.toUpperCase()} yet.`;
      status.progress = progress(dates, MIN_DISTINCT_DATES, "distinct decision dates at the traded horizon", 45);
      status.calls = calls("zero_incremental", "Derived from labels already written by the maturation job. No provider request and no table written.");
      status.latestAt = labelRows.length ? labelRows.map((row) => row.date).sort().at(-1) ?? null : null;
      status.blockers = decidable ? [] : [
        `${dates}/${MIN_DISTINCT_DATES} distinct decision dates at the ${PRIMARY_HORIZON_DAYS}-day horizon. A geometry chosen below this floor is fitted to one regime.`,
      ];
      status.nextAction = decidable
        ? "Re-run GET /api/agents/exit-geometry-shadow and open a separate architecture round. Coverage alone does not authorise an exit change."
        : "Let maturation accumulate dates. Do not change a stop, target or time stop from the current numbers.";
      status.details = [
        "Measured 2026-08-06 and NOT acted on: for US, targets of 19.2%, 10% and 6% produce the identical mean, because most positions never reach +6% at all.",
        "For India, a 6% target with a 5% stop beat the live geometry, with +4% worse than +6% — an interior optimum, not 'shorter is better'.",
        "A window that touched both candidate levels is ambiguous: max-excursion data cannot order them.",
      ];
      status.available = !labelCoverageRes.error;
      return status;
    }

    if (program.id === "horizon-extension") {
      const dates = new Set(horizonExtensions.map((row: any) => String(row.evaluated_at).slice(0, 10))).size;
      const latest = horizonExtensions[0]?.evaluated_at ?? null;
      status.lifecycle = horizonExtensions.length ? (dates >= 20 ? "ready_for_review" : "collecting") : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${horizonExtensions.length} position evaluation(s) across ${dates} evaluation date(s); ${horizonExtensions.filter((row: any) => row.would_extend).length} would extend.`;
      status.progress = progress(dates, 20, "independent evaluation dates", 90);
      status.calls = calls("zero_incremental", "Reuses prices, scores and risk inputs already fetched by the position-monitor flow.");
      status.latestAt = latest;
      status.blockers = dates >= 20 ? ["Matched forward outcomes and owner review are still required before any exit-policy change."] : [`${dates}/20 independent evaluation dates collected.`];
      status.nextAction = dates >= 20 ? "Review matched outcomes; do not change the time stop from the counterfactual alone." : "Continue daily market-local collection.";
      status.details = ["This is a counterfactual only; its output cannot hold or close a position."];
      status.available = !horizonExtensionRes.error;
      return status;
    }

    if (program.id === "exit-stop-shadow") {
      const dates = new Set(exitStopRuns.map((row: any) => String(row.as_of_date))).size;
      const latest = exitStopRuns[0]?.created_at ?? null;
      const measured = exitStopRuns.filter((row: any) => row.status === "measured").length;
      status.lifecycle = exitStopRuns.length ? (measured ? "ready_for_review" : "collecting") : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${exitStopRuns.length} paired run row(s) across ${dates} as-of date(s); ${measured} meet the row-level measured status.`;
      status.progress = progress(dates, 12, "independent as-of dates", 90);
      status.calls = calls("zero_incremental", "Uses matured observation labels; no provider request is made by the shadow.");
      status.latestAt = latest;
      status.blockers = measured && dates >= 12 ? ["Cost/FDR, worst-case and owner review remain required; measured is not promotion."] : ["The ATR-stop evidence floor is not met; the first scheduled weekly run may not have written a row yet."];
      status.nextAction = "Keep the ATR stop measure-only until paired evidence and the owner gate are complete.";
      status.details = ["Target and time stop are held identical so the paired difference attributes only the stop change."];
      status.available = !exitStopRunRes.error;
      return status;
    }

    if (program.id === "archetype-ic") {
      const eligible = archetypeRuns.filter((row: any) => row.cohort === "eligible_long");
      const dates = new Set(eligible.map((row: any) => String(row.as_of_date ?? row.created_at).slice(0, 10))).size;
      const latest = archetypeRuns[0]?.created_at ?? null;
      status.lifecycle = eligible.length ? (dates >= 20 ? "ready_for_review" : "collecting") : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${eligible.length} eligible-long archetype grade(s) across ${dates} independent date(s); all-scored context is excluded from the grade.`;
      status.progress = progress(dates, 20, "independent eligible-long dates", 90);
      status.calls = calls("zero_incremental", "Grades persisted shadow decisions and labels; no provider request is made.");
      status.latestAt = latest;
      status.blockers = dates >= 20 ? ["Sealed validation and owner promotion are still required."] : [`${dates}/20 independent eligible-long dates collected.`];
      status.nextAction = "Continue both-market collection and compare arms only on the declared eligible-long cohort.";
      status.details = ["The all-scored cohort is retained only as context and cannot authorize a weighting change."];
      status.available = !archetypeIcRes.error;
      return status;
    }

    if (program.id === "alpha-diagnostics") {
      const completed = alphaDiagnosticRuns.filter((row: any) => row.completed_at != null);
      const latest = alphaDiagnosticRuns[0]?.created_at ?? null;
      const dates = new Set(completed.map((row: any) => String(row.created_at).slice(0, 10))).size;
      status.lifecycle = completed.length ? "collecting" : alphaDiagnosticRuns.length ? "blocked" : "idle";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${completed.length} completed diagnostic run(s) in the last 90 days across ${dates} run date(s); no run can promote a strategy.`;
      status.progress = progress(completed.length, 20, "completed diagnostic runs", 90);
      status.calls = calls("zero_incremental", "Reads existing portfolio and evidence ledgers; the Lab makes no provider request.");
      status.latestAt = latest;
      status.blockers = completed.length ? ["Diagnostics are evidence only; any repair requires a separate predeclared replay/shadow and owner decision."] : ["No completed diagnostic run is available yet."];
      status.nextAction = "Review the latest A0-to-A9 funnel result and create a separately governed experiment only if warranted.";
      status.details = ["A0 data truth gates interpretation of downstream tests; incomplete runs are not treated as evidence."];
      status.available = !alphaDiagnosticRes.error;
      return status;
    }

    if (program.id === "dimension-diagnostics") {
      const latestByHorizon = new Map<number, any>();
      for (const row of diagnosticRuns) {
        if (!latestByHorizon.has(Number(row.horizon_days))) latestByHorizon.set(Number(row.horizon_days), row);
      }
      const latest = diagnosticRuns[0] ?? null;
      const latestTen = latestByHorizon.get(10) ?? latest;
      const sessions = Number(latestTen?.distinct_session_count ?? 0);
      const insufficient = [...latestByHorizon.values()].filter((row) => row.status === "insufficient_evidence").length;
      status.lifecycle = latest ? (insufficient > 0 ? "collecting" : "ready_for_review") : "idle";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = latest
        ? `${market.toUpperCase()} latest P0 diagnostics recorded ${latestByHorizon.size}/4 horizon(s); ${insufficient} remain below the evidence floor.`
        : `No ${market.toUpperCase()} P0 dimension diagnostic run has been recorded yet.`;
      status.progress = progress(sessions, 20, "qualifying sessions at the latest diagnostic horizon", 45);
      status.calls = calls("zero_incremental", "Reads the existing decision and matured-label ledgers. It makes no provider or LLM call.");
      status.latestAt = latest?.created_at ?? null;
      status.blockers = !latest ? ["The scheduled P0 diagnostic has not yet written a run."]
        : insufficient > 0 ? [`${insufficient} horizon(s) remain insufficient for a predictive conclusion; no repair candidate is created.`] : [];
      status.nextAction = !latest
        ? "Wait for the next market-local diagnostic schedule or run the owner-only endpoint once."
        : insufficient > 0
          ? "Let mature labels accumulate. Do not reward/punish an agent or change a dimension from this sample."
          : "Review descriptive findings; any repair still needs a separate, bounded candidate and sealed validation.";
      status.details = [...latestByHorizon.values()].map((row) => `${row.horizon_days}d: ${row.input_observation_count} labels across ${row.distinct_session_count} session(s), ${row.status}.`);
      status.available = !dimensionDiagnosticRunRes.error;
      return status;
    }

    if (program.id === "decision-label-coverage") {
      const binding = bindingCoverage(labelCoverage);
      const blockers = coverageBlockers(labelCoverage);
      const totalDates = new Set(labelRows.map((row) => row.date)).size;
      // Never "ready_for_review": this program is permanently measure-only and
      // has no activation to be ready for. It reports collecting or blocked.
      status.lifecycle = labelRows.length === 0 ? "idle" : blockers.length ? "blocked" : "collecting";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = binding
        ? `${market.toUpperCase()} ${binding.horizonDays}-day horizon: ${binding.observations} matured labels across ${binding.distinctDates} decision date(s) and ${binding.distinctSymbols} symbol(s); ${binding.eligibleObservations} were entry-eligible.`
        : `No matured ${market.toUpperCase()} decision labels.`;
      status.progress = progress(binding?.distinctDates ?? 0, MIN_DISTINCT_DATES, "distinct decision dates", 45, {
        completed: binding?.distinctSymbols ?? 0,
        target: Math.max(1, binding?.distinctSymbols ?? 1),
        unit: "symbols at the traded horizon",
      });
      status.calls = calls("zero_incremental", "Reads two evidence tables already written by the research and maturation jobs. No provider request.");
      status.latestAt = labelRows.length
        ? labelRows.map((row) => row.date).sort().at(-1) ?? null
        : null;
      status.blockers = blockers;
      status.nextAction = blockers.length
        ? `Let maturation accumulate distinct decision dates. Do not read a scoring, universe or exit result off the ${binding?.horizonDays ?? PRIMARY_HORIZON_DAYS}-day cohort until it clears ${MIN_DISTINCT_DATES} dates.`
        : "Coverage clears the floor at the traded horizon. Results may be interpreted, still with overlap and multiple-testing caveats.";
      status.details = [
        `${totalDates} distinct decision date(s) across all horizons.`,
        ...labelCoverage.map((row) =>
          `${row.horizonDays}d: n=${row.observations}, ${row.distinctDates} date(s), ${row.distinctSymbols} symbol(s), ${row.observationsPerDate.toFixed(1)} obs/date`),
        "n is not the sample size. Overlapping forward windows and correlated symbols mean the effective sample is closer to the date count.",
      ];
      status.available = !labelCoverageRes.error;
      return status;
    }

    if (program.id === "evidence-router") {
      const active = activePolicies.map((pointer: any) => {
        const version = policyVersions.find((row: any) => row.id === pointer.policy_version_id);
        return { market: pointer.market, enabled: version?.router_enabled === true };
      });
      const validPasses = evaluations.filter((row: any) =>
        row.passed === true && row.safety_pass === true && row.quality_pass === true
        && row.expires_at && new Date(row.expires_at).getTime() > Date.now());
      const latest = evaluations[0];
      const passingSessions = new Set(validPasses.map((row: any) => row.market_session_date).filter(Boolean));
      const network = networkCallRes.count ?? 0;
      const cacheHits = cacheHitRes.count ?? 0;
      status.lifecycle = passingSessions.size >= 10 ? "ready_for_review" : "blocked";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${validPasses.length} valid passing ${market.toUpperCase()} evaluation(s); router remains ${active.some((row: any) => row.enabled) ? "enabled" : "disabled"} for this market.`;
      status.progress = progress(passingSessions.size, 10, "fresh passing market-session proofs", 45);
      status.calls = calls("tracked", "Exact Router ledger counts over the last 7 days; network attempts are separated from cache-only resolutions.", ledgerCount, network, cacheHits);
      status.latestAt = latestIso(evaluations, "created_at");
      status.blockers = !latest || latest.passed !== true || latest.safety_pass !== true || latest.quality_pass !== true
        ? [`${market.toUpperCase()} latest parity evaluation is not a full safety+quality pass.`]
        : [];
      if (!status.blockers.length && validPasses.length < 1) status.blockers.push(`${market.toUpperCase()} needs a fresh, unexpired passing evaluation.`);
      if (validPasses.length > 0 && passingSessions.size < 10) status.blockers.push(`${market.toUpperCase()} has ${passingSessions.size}/10 distinct fresh passing market sessions.`);
      status.nextAction = status.lifecycle === "ready_for_review"
        ? "Review flagged divergences and prepare a separate market-local activation decision."
        : "Repair failing coverage/quality dimensions and continue daily cohort proofs.";
      status.details = [`${market.toUpperCase()} latest: ${latest?.passed ? "pass" : "fail or unavailable"}`];
      status.available = !evaluationRes.error && !callLedgerRes.error && !networkCallRes.error && !cacheHitRes.error;
      return status;
    }

    if (program.id === "degradation-guard") {
      const wouldAbstain = degradation.filter((row: any) => row.action === "abstain_new_long").length;
      const evaluationRuns = evaluations.length;
      status.lifecycle = degradation.length || evaluationRuns ? "collecting" : "idle";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${wouldAbstain} new-long abstention(s) would have fired in the last 7 days; none changed behavior.`;
      status.progress = progress(degradation.length, null, "counterfactual events", 7);
      status.calls = calls("zero_incremental", "Uses the evidence mask already produced by ResearchAgent; no additional provider fetch.");
      status.latestAt = latestIso(degradation, "created_at") ?? latestIso(evaluations, "created_at");
      status.blockers = ["False-positive review and a stable market-local baseline are not complete."];
      status.nextAction = "Review the would-abstain sample before considering enforce mode.";
      status.details = [
        "Mode remains measure_only.",
        "Only long-to-neutral could ever be permitted.",
        `${evaluationRuns} Router/evidence evaluation run(s) prove liveness even when zero degradation events are expected.`,
      ];
      status.available = !degradationRes.error && !evaluationRes.error;
      return status;
    }

    if (program.id === "india-news-evidence") {
      const rssRows = indiaNewsRows.filter((row: any) => row.intent === "sentiment.news_headlines_shadow");
      const freshRssSymbols = new Set(rssRows.filter((row: any) => row.quality_state === "fresh").map((row: any) => row.symbol));
      const observedSymbols = new Set(rssRows.map((row: any) => row.symbol));
      const dates = new Set<string>(indiaNewsHistory.map((row: any) => String(row.created_at ?? "").slice(0, 10)).filter(Boolean));
      const coverage = observedSymbols.size > 0 ? freshRssSymbols.size / observedSymbols.size : 0;
      const sortedDates = [...dates].sort();
      const observationWindowDays = sortedDates.length > 1
        ? Math.max(1, Math.ceil((new Date(sortedDates[sortedDates.length - 1]).getTime() - new Date(sortedDates[0]).getTime()) / 86400_000) + 1)
        : 1;
      status.lifecycle = dates.size >= 20 && coverage >= 0.7 ? "ready_for_review" : "collecting";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${freshRssSymbols.size}/${observedSymbols.size || 0} recently observed symbols have relevant headlines; ${dates.size}/20 collection dates.`;
      status.progress = progress(dates.size, 20, "collection dates", observationWindowDays, {
        completed: freshRssSymbols.size,
        target: observedSymbols.size || 1,
        unit: "symbols with relevant headlines",
      });
      status.calls = calls(
        "tracked",
        "Exact India news-shadow ledger counts over the last 7 days. No app research-provider API key is used.",
        indiaNewsLedgerRes.count ?? 0,
        indiaNewsNetworkRes.count ?? 0,
        0,
      );
      status.latestAt = latestIso(indiaNewsRows, "fetched_at");
      status.blockers = [
        ...(dates.size < 20 ? [`Needs ${20 - dates.size} more distinct collection dates.`] : []),
        ...(coverage < 0.7 ? [`Relevant-headline coverage is ${(coverage * 100).toFixed(0)}%; review at 70% or higher.`] : []),
        "No deterministic sentiment classifier has passed PIT walk-forward validation.",
      ];
      status.nextAction = status.lifecycle === "ready_for_review"
        ? "Review source relevance and design a separate historical classifier experiment; do not activate directly."
        : "Continue bounded daily collection and inspect false matches/provider failures.";
      status.details = [
        "Official NSE announcements and unofficial Google News RSS are stored as separate providers.",
        "The active India score does not read either shadow intent.",
      ];
      status.available = !indiaNewsCacheRes.error && !indiaNewsLedgerRes.error && !indiaNewsNetworkRes.error && !indiaNewsHistoryRes.error;
      return status;
    }

    if (program.id === "setup-experts") {
      const wouldEnter = shadowDecisions.filter((row: any) => row.would_enter).length;
      const setups = new Map<string, number>();
      shadowDecisions.forEach((row: any) => setups.set(row.setup_type ?? "strategy_version", (setups.get(row.setup_type ?? "strategy_version") ?? 0) + 1));
      const expectedAlwaysOn = market === "india" ? ["india_quality_momentum", "india_sector_rotation"] : ["quality_momentum"];
      const missingAlwaysOn = expectedAlwaysOn.filter((setup) => !setups.has(setup));
      status.lifecycle = missingAlwaysOn.length ? "blocked" : shadowDecisions.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${shadowDecisions.length} comparable decisions and ${wouldEnter} would-enter decisions in 7 days; forward outcome comparison is not mature.`;
      status.progress = progress(shadowDecisions.length, null, "shadow decisions", 7);
      status.calls = calls("zero_incremental", "Replays formulas from the same ResearchAgent inputs; no second provider call.");
      status.latestAt = latestIso(shadowDecisions, "ts");
      // MEASURE the multi-expert contract; do not assert it.
      //
      // This blocker used to read, unconditionally: "The production idempotency
      // index currently permits only one NULL-policy setup row per observation,
      // so multi-expert batches are not trustworthy." It was hardcoded, so it
      // was emitted on every run whether or not it was true — and it was not
      // true. The nextAction beside it prescribed "separate challenger and
      // (observation, setup_type) uniqueness", which is exactly what production
      // already has:
      //
      //   shadow_decisions_observation_policy_uidx
      //     UNIQUE (observation_id, policy_version_id) WHERE both NOT NULL
      //   shadow_decisions_observation_setup_uidx
      //     UNIQUE (observation_id, setup_type) NULLS NOT DISTINCT
      //     WHERE policy_version_id IS NULL
      //
      // Measured 2026-09-02: 5,455 policy-less rows, ZERO with a null
      // setup_type, and 1,279 observations carrying 2-4 distinct experts (48
      // with four, 890 with three, 341 with two). The prescribed fix had already
      // shipped; only the prose still claimed otherwise, and it kept the program
      // marked blocked on a defect that no longer existed.
      status.details = [...setups.entries()].map(([name, count]) => `${name}: ${count} decisions`);
      const expertsPerObservation = new Map<string, Set<string>>();
      for (const row of shadowDecisions as any[]) {
        const observationId = row.observation_id == null ? null : String(row.observation_id);
        if (!observationId || !row.setup_type) continue;
        const set = expertsPerObservation.get(observationId) ?? new Set<string>();
        set.add(String(row.setup_type));
        expertsPerObservation.set(observationId, set);
      }
      const multiExpertObservations = [...expertsPerObservation.values()].filter((set) => set.size > 1).length;

      status.blockers = [
        ...(missingAlwaysOn.length ? [`Missing always-on setup evidence: ${missingAlwaysOn.join(", ")}.`] : []),
        // Absence of evidence, stated as absence — not as a claim about the schema.
        ...(multiExpertObservations === 0 && shadowDecisions.length > 0
          ? ["No observation in the last 7 days carries more than one setup expert, so the multi-expert path is unproven in this window."]
          : []),
        "No approved minimum labelled sample or promotion gate exists for setup experts.",
      ];
      status.nextAction = multiExpertObservations > 0
        ? "Define a predeclared walk-forward comparison and a minimum labelled sample before any setup expert may influence scoring."
        : "Confirm a multi-expert batch actually lands for one observation, then define a predeclared walk-forward comparison and minimum labelled sample.";
      status.details.push(`${multiExpertObservations} observation(s) carry more than one setup expert in the last 7 days.`);
      status.available = !shadowDecisionRes.error;
      return status;
    }

    if (program.id === "technical-calibration") {
      const best = [...readiness].sort((a: any, b: any) => {
        const ar = Number(a.windows_observed ?? 0) / Math.max(1, Number(a.windows_required ?? 6));
        const br = Number(b.windows_observed ?? 0) / Math.max(1, Number(b.windows_required ?? 6));
        return br - ar;
      })[0];
      const completed = Number(best?.windows_observed ?? 0);
      const target = Number(best?.windows_required ?? 6);
      const readyForShadowReview = readiness.some((row: any) => row.stage === "ready_for_shadow_review");
      const readyForValidationBuild = readiness.some((row: any) => row.stage === "ready_for_validation_build");
      const reviewMilestone = readyForShadowReview || readyForValidationBuild;
      status.lifecycle = reviewMilestone ? "ready_for_review" : edgeSignals.length ? "collecting" : "idle";
      status.benefitVerdict = reviewMilestone ? "promising" : "insufficient";
      status.benefitEvidence = reviewMilestone
        ? `At least one technical edge reached ${readyForShadowReview ? "shadow review" : "validation-build review"}; no scoring change is authorized.`
        : `${edgeSignalRes.count ?? edgeSignals.length} technical edge observations in 7 days; weekly stability windows remain incomplete.`;
      status.progress = {
        ...progress(completed, target, "weekly stability windows", Math.max(7, completed * 7 || 7)),
        ratePerDay: completed > 0 ? 1 / 7 : null,
        estimatedDays: completed < target ? (target - completed) * 7 : null,
        secondary: best ? {
          completed: Number(best.validation_windows_observed ?? 0),
          target: Number(best.validation_windows_required ?? 4),
          unit: "cost/FDR validation windows",
        } : null,
      };
      status.calls = calls("unmetered", "EdgeScout fetches are not consistently written to provider_call_ledger; the page refuses to report them as zero.");
      status.latestAt = latestIso(edgeSignals, "created_at") ?? latestIso(readiness, "evaluated_at");
      status.blockers = readyForShadowReview
        ? ["Owner review and a separate shadow-admission decision remain required."]
        : readyForValidationBuild
          ? ["The edge is ready to build/collect validation evidence, but its required cost/FDR validation windows are still incomplete."]
          : ["Stable weekly and point-in-time cost/FDR windows are incomplete."];
      status.nextAction = readyForShadowReview
        ? "Review the edge diagnostics for shadow admission; do not edit scoring directly."
        : readyForValidationBuild
          ? "Run the predeclared cost/FDR validation phase; do not admit the edge to scoring or shadow yet."
          : "Continue EdgeScout/EdgeIC collection.";
      status.details = [`${edgeSignalRes.count ?? edgeSignals.length} ${market.toUpperCase()} technical observations in the last 7 days.`, `${readiness.length} readiness cells tracked.`];
      status.available = !edgeSignalRes.error && !edgeReadinessRes.error;
      return status;
    }

    if (program.id === "pit-fundamental-qualification") {
      const symbols = new Set(fundamentalFacts.map((row: any) => row.symbol).filter(Boolean));
      const sources = new Set(fundamentalFacts.map((row: any) => row.source).filter(Boolean));
      const dated = fundamentalFacts.filter((row: any) => row.filing_date != null).length;
      status.lifecycle = fundamentalFacts.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${fundamentalFacts.length} captured ${market.toUpperCase()} fundamental vintages across ${symbols.size} symbols; ${dated} include a provider filing date.`;
      status.progress = progress(fundamentalFacts.length, null, "captured vintages", 90, {
        completed: dated,
        target: Math.max(1, fundamentalFacts.length),
        unit: "vintages with a filing date",
      });
      status.calls = calls("zero_incremental", "Capture reuses the fundamentals already fetched for research; the dashboard makes no provider request.");
      status.latestAt = latestIso(fundamentalFacts, "captured_at");
      status.blockers = [
        "No market-local source qualification record exists yet for gross profitability, debt/equity, FCF yield, or acceleration.",
        "A captured current snapshot is not valid historical evidence until known-at, units, restatements and taxonomy are reviewed.",
      ];
      status.nextAction = "Qualify one small per-market reported-fundamental trial family before creating replay inputs; do not backfill current snapshots as past facts.";
      status.details = [
        `${sources.size} source label(s) observed in the last 90 days.`,
        "No candidate fundamental metric is in the canonical score.",
      ];
      status.available = !fundamentalFactsRes.error;
      return status;
    }

    if (program.id === "specialist-feature-packs") {
      status.lifecycle = "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = "No specialist pack is collecting evidence yet; generic price/liquidity rules remain the only applicable contract.";
      status.progress = progress(0, null, "qualified specialist contracts", 0);
      status.calls = calls("not_applicable", "No specialist source is called until a per-instrument data contract is approved.");
      status.latestAt = null;
      status.blockers = [
        "Banks need capital, asset-quality and net-interest-margin data.",
        "REITs need FFO/AFFO, occupancy, leverage and rate-sensitivity data.",
        "Leveraged ETFs need underlying-trend, volatility, gap and holding-duration controls.",
      ];
      status.nextAction = "Select one instrument family only after its raw data source and market-local risk contract are qualified.";
      status.details = ["No generic-company fundamental is silently applied to an ETF, bank or REIT."];
      status.available = true;
      return status;
    }

    if (program.id === "capital-rotation") {
      const paperEnabled = rotationConfig.some((row: any) => row.book_type === "paper" && row.rotation_paper_execute_enabled === true);
      const liveEnabled = rotationConfig.some((row: any) => row.book_type === "live" && row.rotation_live_proposals_enabled === true);
      const paperExecuted = rotationEvents.filter((row: any) => row.status === "paper_executed").length;
      const closedOutcomes = rotationTrades.filter((row: any) => row.closed_at != null);
      const pnl = closedOutcomes.reduce((sum: number, row: any) => sum + Number(row.realized_pnl ?? 0), 0);
      status.lifecycle = paperEnabled ? "paper_active" : rotationEvents.length ? "collecting" : "idle";
      status.benefitVerdict = closedOutcomes.length >= 10 ? (pnl > 0 ? "promising" : "not_beneficial") : "insufficient";
      status.benefitEvidence = `${paperExecuted} paper rotation(s) in 45 days; ${closedOutcomes.length} closed rotation outcome(s) available for net-benefit review.`;
      status.progress = progress(rotationEvents.length, null, "rotation evaluations", 45);
      status.calls = calls("zero_incremental", "Uses candidate/holding scores and prices already fetched by the paper-trade flow.");
      status.latestAt = latestIso(rotationEvents, "created_at");
      status.blockers = liveEnabled ? [] : ["Live rotation proposals are disabled.", "Closed net-of-cost/tax outcome sample is thin."];
      status.nextAction = "Keep paper execution bounded; review churn, realized outcomes and two-leg reconciliation before any live proposal.";
      status.details = [`Paper execution: ${paperEnabled ? "enabled" : "disabled"}.`, `Live proposals: ${liveEnabled ? "enabled" : "disabled"}.`];
      status.available = !rotationConfigRes.error && !rotationEventRes.error;
      return status;
    }

    if (program.id === "earnings-risk") {
      const entries = earnings.filter((row: any) => row.decision_kind === "entry");
      const events = new Set(entries.filter((row: any) => row.report_date).map((row: any) => `${row.market}:${row.report_date}`));
      const usable = entries.filter((row: any) => row.options_quality === "usable").length;
      const changed = earnings.filter((row: any) => row.behavior_changed).length;
      const usFloorsMet = entries.length >= 60 && events.size >= 20;
      status.lifecycle = market === "us" && usFloorsMet ? "ready_for_review" : entries.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = market === "us"
        ? `${entries.length}/60 eligible-entry observations, ${events.size}/20 distinct events and ${usable} usable move proxies; ${changed} behavior changes.`
        : `${entries.length} eligible-entry observations and ${events.size} distinct India earnings events; options-implied move is intentionally unavailable.`;
      status.progress = market === "us"
        ? progress(entries.length, 60, "eligible entry observations", 90, { completed: events.size, target: 20, unit: "distinct earnings events" })
        : progress(entries.length, null, "India earnings-proximity observations", 90);
      if (market === "us" && events.size < 20 && entries.length > 0) {
        const eventRate = events.size / 90;
        const eventEta = eventRate > 0 ? Math.ceil((20 - events.size) / eventRate) : null;
        status.progress.estimatedDays = Math.max(status.progress.estimatedDays ?? 0, eventEta ?? 0) || null;
      }
      status.calls = calls("unmetered", "Robinhood/Yahoo earnings-option reads are bounded but not yet written to provider_call_ledger.");
      status.latestAt = latestIso(earnings, "created_at");
      status.blockers = market === "us"
        ? [
          ...(!usFloorsMet ? ["The 60-entry and 20-event evidence floors are not both met."] : []),
          "A usable quote-coverage criterion is not yet predeclared, and calibration review remains pending.",
          "A separate owner decision is required before any deterministic entry block or size reduction.",
        ]
        : ["No India behavior-change target is approved; options-implied movement is not available for India."];
      status.nextAction = market === "us"
        ? "Let US candidate traffic collect observations; do not add options to analyst_score."
        : "Continue India earnings-proximity measurement without borrowing US options evidence.";
      status.details = market === "us" ? ["US can measure a same-strike move proxy."] : ["India records event proximity only."];
      status.available = !earningsRiskRes.error;
      return status;
    }

    if (program.id === "exogenous-risk") {
      const fresh = exogenousObservations.filter((row: any) => row.quality === "fresh");
      const series = new Set(exogenousObservations.map((row: any) => `${row.market}:${row.series_key}`));
      const latestObservation = latestIso(exogenousObservations, "available_at") ?? latestIso(exogenousObservations, "created_at");
      const latestRun = latestIso(marketRegimeRuns, "computed_at");
      status.lifecycle = exogenousObservations.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${fresh.length}/${exogenousObservations.length} fresh source observation(s) across ${series.size} market-series; ${marketRegimeRuns.length} regime shadow run(s).`;
      status.progress = progress(exogenousObservations.length, null, "source observations", 90);
      status.calls = calls("not_applicable", "P0 only persists governed evidence ledgers; no source adapter or network collection is enabled yet.");
      status.latestAt = latestObservation ?? latestRun;
      status.blockers = [
        "No stable, timestamped official source adapter is enabled.",
        "No point-in-time coverage or market-local validation evidence exists.",
        "No score, signal, paper/live trade, exit, sizing, or broker reader is approved.",
      ];
      status.nextAction = "Verify official machine-readable source contracts, then start bounded source collection without adding a decision consumer.";
      status.details = [
        `${market.toUpperCase()} is displayed independently; global observations are context only and are never cross-summed with a market book.`,
        `${marketRegimeRuns.length} market-local regime shadow run(s) are retained for review only.`,
        "Missing observations remain unavailable, not a neutral regime.",
      ];
      status.available = !exogenousObservationRes.error && !marketRegimeRunRes.error;
      return status;
    }

    if (program.id === "international-allocation") {
      const policy = allocationPolicies[0];
      const targetSet = policy?.target_pct != null && policy?.deadband_pct != null;
      status.lifecycle = targetSet ? "ready_for_review" : allocationAssessments.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${allocationAssessments.length} weekly/diagnostic assessment(s) in 90 days; target and deadband are ${targetSet ? "set" : "unset"}.`;
      status.progress = progress(allocationAssessments.length, null, "allocation assessments", 90);
      status.calls = calls("zero_incremental", "Reads persisted positions and policy snapshots; the weekly operational shadow makes no provider call.");
      status.latestAt = latestIso(allocationAssessments, "created_at") ?? policy?.updated_at ?? null;
      status.blockers = targetSet ? ["Paper allocation policy still requires owner approval."] : ["No target allocation or deadband is approved.", "Broader family/cost/tax comparison is incomplete."];
      status.nextAction = "Keep observing VXUS; define a target only after the broader policy review.";
      status.details = [`Latest policy status: ${policy?.status ?? "unavailable"}.`, "India/INR is not read or cross-summed."];
      status.available = !allocationPolicyRes.error && !allocationAssessmentRes.error;
      return status;
    }

    if (program.id === "autonomous-live") {
      const enabled = strategyConfig?.live_auto_enabled === true;
      const anyScheduled = status.schedules.some((row) => row.active);
      status.lifecycle = enabled ? (autonomousProposals.length ? "collecting" : "idle") : "off";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${autonomousProposals.length} autonomous-shadow proposal(s) in 45 days; live_auto_enabled=${enabled}.`;
      status.progress = progress(autonomousProposals.length, null, "kernel evaluations", 45);
      status.calls = calls("unmetered", "The campaign is off. Quote calls would need ledger instrumentation before a future restart.");
      status.latestAt = latestIso(autonomousProposals, "created_at");
      status.blockers = ["No approved evidence campaign is active.", "Broker canaries and kill-switch drills are pending."];
      status.nextAction = anyScheduled ? "Disable the idle schedules." : "Leave off until a new campaign with a declared sample target is approved.";
      status.details = [`${market.toUpperCase()} mode: ${market === "us" ? strategyConfig?.live_auto_mode_us ?? "unknown" : strategyConfig?.live_auto_mode_india ?? "unknown"}.`];
      status.available = !strategyConfigRes.error && !autonomousProposalRes.error;
      return status;
    }

    if (program.id === "challenger-validation") {
      const armed = validationPolicies.some((row: any) => row.enabled && row.auto_shadow_enabled);
      status.lifecycle = shadowVersions.length ? "collecting" : armed ? "armed" : "off";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${shadowVersions.length} active shadow_paper challenger(s); automation is ${armed ? "armed" : "disabled"}.`;
      status.progress = progress(shadowVersions.length, null, "active shadow challengers", 45);
      status.calls = calls("zero_incremental", "Validation reuses persisted observations and labels; it does not repair inputs with provider calls.");
      status.latestAt = latestIso(shadowVersions, "created_at") ?? latestIso(validationPolicies, "updated_at");
      status.blockers = shadowVersions.length ? ["Shadow outcome evidence must mature before any promotion review."] : ["No passing challenger currently occupies a shadow slot."];
      status.nextAction = shadowVersions.length ? "Collect matched shadow outcomes." : "Wait for a learner challenger that passes deterministic validation.";
      status.details = validationPolicies.map((row: any) => `${String(row.market).toUpperCase()}: ${row.enabled && row.auto_shadow_enabled ? "armed" : "off"}`);
      status.available = !validationPolicyRes.error && !shadowVersionRes.error;
      return status;
    }

    if (program.id === "downside-hedge") {
      const enabled = downsideConfigs.some((row: any) => row.enabled);
      const paperEnabled = downsideConfigs.some((row: any) => row.paper_execute_enabled);
      status.lifecycle = enabled ? (downsideEvents.length ? "collecting" : "idle") : "off";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${downsideEvents.length} event(s) in 90 days; shadow enabled=${enabled}, paper execution=${paperEnabled}.`;
      status.progress = progress(downsideEvents.length, null, "hedge evaluations", 90);
      status.calls = calls("zero_incremental", "Uses persisted portfolio/macro inputs; no separate provider call is required.");
      status.latestAt = latestIso(downsideEvents, "created_at") ?? latestIso(downsideConfigs, "updated_at");
      status.blockers = ["Shadow collection is disabled.", "Hedge precision and drag have not been measured."];
      status.nextAction = "Leave off until an explicit hedge evidence campaign is approved.";
      status.details = ["No live path exists."];
      status.available = !downsideConfigRes.error && !downsideEventRes.error;
      return status;
    }

    return status;
  });

  return statuses.map((status) => ({ ...status, deployment: deploymentFor(status) }));
}
