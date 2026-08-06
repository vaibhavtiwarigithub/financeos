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
      .select("market,setup_type,would_enter,ts").eq("market", market).gte("ts", since7).limit(5000),
    svc.from("edge_signals")
      .select("market,edge_id,created_at", { count: "exact" })
      .eq("market", market)
      .in("edge_id", ["kairos_technical_score_v1", "macd_atr_12_26_9", "signed_adx_14"])
      .gte("created_at", since7).limit(10000),
    svc.from("edge_readiness_status")
      .select("market,edge_id,horizon,windows_observed,windows_required,validation_windows_observed,validation_windows_required,stage,next_action,evaluated_at")
      .eq("market", market)
      .in("edge_id", ["kairos_technical_score_v1", "macd_atr_12_26_9", "signed_adx_14"]).limit(200),
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
    svc.from("observation_labels")
      .select("horizon_days,fwd_return,decision_observations!inner(ts,symbol,market,entry_eligible)")
      .eq("decision_observations.market", market).limit(20000),
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

  return SHADOW_PROGRAMS.map((program) => {
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
      const sessions = new Set(evaluations.map((row: any) => row.market_session_date).filter(Boolean));
      const network = networkCallRes.count ?? 0;
      const cacheHits = cacheHitRes.count ?? 0;
      status.lifecycle = validPasses.length >= 1 ? "ready_for_review" : "blocked";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${validPasses.length} valid passing ${market.toUpperCase()} evaluation(s); router remains ${active.some((row: any) => row.enabled) ? "enabled" : "disabled"} for this market.`;
      status.progress = progress(sessions.size, 10, "market-session proofs", 45);
      status.calls = calls("tracked", "Exact Router ledger counts over the last 7 days; network attempts are separated from cache-only resolutions.", ledgerCount, network, cacheHits);
      status.latestAt = latestIso(evaluations, "created_at");
      status.blockers = !latest || latest.passed !== true || latest.safety_pass !== true || latest.quality_pass !== true
        ? [`${market.toUpperCase()} latest parity evaluation is not a full safety+quality pass.`]
        : [];
      if (!status.blockers.length && validPasses.length < 1) status.blockers.push(`${market.toUpperCase()} needs a fresh, unexpired passing evaluation.`);
      status.nextAction = status.lifecycle === "ready_for_review"
        ? "Review flagged divergences and prepare a separate market-local activation decision."
        : "Repair failing coverage/quality dimensions and continue daily cohort proofs.";
      status.details = [`${market.toUpperCase()} latest: ${latest?.passed ? "pass" : "fail or unavailable"}`];
      status.available = !evaluationRes.error && !callLedgerRes.error && !networkCallRes.error && !cacheHitRes.error;
      return status;
    }

    if (program.id === "degradation-guard") {
      const wouldAbstain = degradation.filter((row: any) => row.action === "abstain_new_long").length;
      status.lifecycle = degradation.length ? "collecting" : "idle";
      status.benefitVerdict = "operational_only";
      status.benefitEvidence = `${wouldAbstain} new-long abstention(s) would have fired in the last 7 days; none changed behavior.`;
      status.progress = progress(degradation.length, null, "counterfactual events", 7);
      status.calls = calls("zero_incremental", "Uses the evidence mask already produced by ResearchAgent; no additional provider fetch.");
      status.latestAt = latestIso(degradation, "created_at");
      status.blockers = ["False-positive review and a stable market-local baseline are not complete."];
      status.nextAction = "Review the would-abstain sample before considering enforce mode.";
      status.details = ["Mode remains measure_only.", "Only long-to-neutral could ever be permitted."];
      status.available = !degradationRes.error;
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
      status.lifecycle = shadowDecisions.length ? "collecting" : "idle";
      status.benefitVerdict = "insufficient";
      status.benefitEvidence = `${shadowDecisions.length} comparable decisions and ${wouldEnter} would-enter decisions in 7 days; forward outcome comparison is not mature.`;
      status.progress = progress(shadowDecisions.length, null, "shadow decisions", 7);
      status.calls = calls("zero_incremental", "Replays formulas from the same ResearchAgent inputs; no second provider call.");
      status.latestAt = latestIso(shadowDecisions, "ts");
      status.blockers = ["No approved minimum labelled sample or promotion gate exists for setup experts."];
      status.nextAction = "Accumulate matured labels, then define a predeclared walk-forward comparison.";
      status.details = [...setups.entries()].map(([name, count]) => `${name}: ${count} decisions`);
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
      const ready = readiness.some((row: any) => ["ready_for_shadow_review", "ready_for_validation_build"].includes(row.stage));
      status.lifecycle = ready ? "ready_for_review" : edgeSignals.length ? "collecting" : "idle";
      status.benefitVerdict = ready ? "promising" : "insufficient";
      status.benefitEvidence = ready
        ? "At least one technical edge reached a review milestone; no scoring change is authorized."
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
      status.blockers = ready ? ["Owner review and a separate shadow-admission decision remain required."] : ["Stable weekly and point-in-time cost/FDR windows are incomplete."];
      status.nextAction = ready ? "Review the edge diagnostics; do not edit scoring directly." : "Continue EdgeScout/EdgeIC collection.";
      status.details = [`${edgeSignalRes.count ?? edgeSignals.length} US/India technical observations in the last 7 days.`, `${readiness.length} readiness cells tracked.`];
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
      status.lifecycle = entries.length ? "collecting" : "idle";
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
        ? ["The 60-entry and 20-event evidence floors are not met.", "Quote-quality and calibration review remain pending."]
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
}
