import type { ShadowProgramDefinition } from "@/lib/shadows/registry";

export type ShadowLivenessVerdict =
  | "live"
  | "stale"
  | "frozen"
  | "empty"
  | "expected_empty"
  | "waiting_for_input"
  | "missing_schedule"
  | "inactive_schedule"
  | "unexpected_schedule"
  | "never_run"
  | "failed_schedule_run"
  | "stale_schedule_run"
  | "unknown";

export type ShadowProbeMode = "scheduled" | "event_driven" | "off" | "inert";

export interface ShadowEvidenceProbe {
  mode: ShadowProbeMode;
  table: string | null;
  tsCol: string | null;
  /** Present when evidence is partitioned in the same market as the path. */
  marketCol?: "market";
  marketScope?: "shared" | "single_market";
  expectedIdleHours: number | null;
  expectedRunIdleHours: number | null;
  equals?: Readonly<Record<string, string>>;
  in?: Readonly<Record<string, readonly string[]>>;
  note: string;
}

export interface CronEvidence {
  jobname: string;
  schedule: string | null;
  active: boolean;
  last_started_at: string | null;
  last_status: string | null;
}

export interface ShadowLivenessResult {
  verdict: ShadowLivenessVerdict;
  note: string;
  schedules: Array<{ job: string; schedule: string | null; active: boolean; found: boolean; lastStartedAt: string | null; lastStatus: string | null }>;
  lastWrite: string | null;
  idleHours: number | null;
}

/** Resolve exactly the schedules assigned to one market; use explicit mappings for non-suffixed job names. */
export function scheduledJobsForMarket(program: ShadowProgramDefinition, market: "us" | "india"): string[] {
  return program.marketCronJobs?.[market]
    ? [...program.marketCronJobs[market]!]
    : program.cronJobs.filter((job) => !/(?:-|_)(?:us|india)$/i.test(job) || job.toLowerCase().endsWith(market));
}

/**
 * Every Upgrade Path program needs an explicit collection contract. A missing
 * table is not treated as a zero-row success, and event-driven programs are not
 * called frozen merely because no qualifying event occurred.
 */
export const SHADOW_EVIDENCE_PROBES: Readonly<Record<string, ShadowEvidenceProbe>> = {
  "new-listing-discovery": { mode: "event_driven", table: "listing_candidates", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 96, note: "Daily SEC index scan; zero rows is valid when no new listing candidates are discovered." },
  "broker-symbol-tradability": { mode: "event_driven", table: "broker_instrument_preflights", tsCol: "checked_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: null, note: "Written only when an exact broker/account order preflight is requested." },
  "score-price-divergence": { mode: "scheduled", table: "score_price_divergence_runs", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Daily market-local divergence and label evaluation." },
  "dimension-diagnostics": { mode: "scheduled", table: "dimension_diagnostic_runs", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Daily market-local diagnostic run; findings may legitimately be empty." },
  "decision-label-coverage": { mode: "scheduled", table: "observation_labels", tsCol: "matured_at", marketScope: "shared", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Shared label maturation; freshness is checked separately from coverage." },
  "exit-geometry": { mode: "scheduled", table: "observation_labels", tsCol: "matured_at", marketScope: "shared", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Uses shared matured labels; it has no independent writer." },
  "horizon-extension": { mode: "event_driven", table: "time_review_exit_observations", tsCol: "observed_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 96, note: "P0 review rows are written only when a held position reaches its exact resolved-horizon checkpoint; the scheduled runner is checked independently, and no checkpoint is a valid wait state." },
  "live-exit-ladder-parity": { mode: "event_driven", table: "live_exit_ladder_shadow", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Hourly monitor is scheduled in market sessions; decisions require a Kairos-managed live position." },
  "exit-stop-shadow": { mode: "scheduled", table: "exit_stop_shadow_runs", tsCol: "created_at", marketCol: "market", expectedIdleHours: 240, expectedRunIdleHours: 240, note: "Weekly market-local fixed-stop versus ATR-stop measurement." },
  "score-exit-shadow": { mode: "scheduled", table: "score_exit_shadow_runs", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Daily market-local score-exit measurement." },
  "archetype-ic": { mode: "scheduled", table: "archetype_ic_runs", tsCol: "created_at", marketCol: "market", expectedIdleHours: 240, expectedRunIdleHours: 240, note: "Weekly market-local archetype IC measurement." },
  "alpha-diagnostics": { mode: "scheduled", table: "backtest_experiments", tsCol: "created_at", marketCol: "market", expectedIdleHours: 240, expectedRunIdleHours: 240, equals: { experiment_type: "alpha_diagnostic" }, note: "Weekly diagnostics; only alpha_diagnostic experiment rows count as this program's evidence." },
  "evidence-router": { mode: "scheduled", table: "evidence_policy_evaluations", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Scheduled policy evidence evaluations, independent of whether routing is enabled." },
  "degradation-guard": { mode: "event_driven", table: "evidence_degradation_events", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 96, note: "Zero degradation rows may mean healthy evidence; scheduled shadow execution is separately verified." },
  "india-news-evidence": { mode: "scheduled", table: "provider_call_ledger", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, equals: { market: "india" }, in: { intent: ["sentiment.news_headlines_shadow", "event.corporate_announcement_shadow"] }, note: "Only India news and corporate-announcement shadow intents count; general provider traffic is not proof." },
  "setup-experts": { mode: "event_driven", table: "shadow_decisions", tsCol: "ts", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 96, note: "Written as a side effect of market-local ResearchAgent decisions; the active research schedule is checked independently, and zero eligible opportunities is a valid wait state." },
  "technical-calibration": { mode: "scheduled", table: "edge_ic_history", tsCol: "created_at", marketCol: "market", expectedIdleHours: 240, expectedRunIdleHours: 240, note: "Weekly market-local edge IC records; scout freshness is a separate signal." },
  "pit-fundamental-qualification": { mode: "event_driven", table: "fundamental_facts", tsCol: "captured_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: null, note: "Capture-on-fetch provenance; no dedicated refresh job is declared." },
  "specialist-feature-packs": { mode: "inert", table: "instrument_registry", tsCol: "last_observed_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: null, note: "Catalog scaffold only; no specialist feature shadow or scheduled producer exists." },
  "capital-rotation": { mode: "event_driven", table: "rotation_events", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: null, note: "Event-driven candidate/holding evaluations; a full book with no qualifying challenger can be idle." },
  "earnings-risk": { mode: "scheduled", table: "earnings_risk_observations", tsCol: "created_at", marketCol: "market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Daily point-in-time event-risk annotations; behavior remains unchanged." },
  "exogenous-risk": { mode: "inert", table: "exogenous_observations", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: null, note: "Schema foundation only; source adapters and collectors are not implemented." },
  "international-allocation": { mode: "scheduled", table: "international_allocation_replay_runs", tsCol: "created_at", marketScope: "single_market", expectedIdleHours: 96, expectedRunIdleHours: 96, note: "Daily US/USD paired replay; weekly assessment is an additional operational record." },
  "autonomous-live": { mode: "off", table: "trade_proposals", tsCol: "created_at", expectedIdleHours: null, expectedRunIdleHours: null, note: "Autonomous live is intentionally off and its idle recurring campaign is removed." },
  "challenger-validation": { mode: "event_driven", table: "validation_experiments", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 240, note: "Weekly validation sweep; an empty candidate queue is a valid wait state." },
  "downside-hedge": { mode: "event_driven", table: "downside_hedge_events", tsCol: "created_at", marketCol: "market", expectedIdleHours: null, expectedRunIdleHours: 96, note: "Scheduled evaluator is active; no rows can be valid when deterministic stress conditions do not occur." },
};

export function missingProbeProgramIds(programs: readonly ShadowProgramDefinition[]): string[] {
  return programs.map((program) => program.id).filter((id) => !Object.prototype.hasOwnProperty.call(SHADOW_EVIDENCE_PROBES, id));
}

export function evaluateShadowLiveness(input: {
  program: ShadowProgramDefinition;
  market: "us" | "india";
  probe: ShadowEvidenceProbe;
  count: number | null;
  lastWrite: string | null;
  cronRows: readonly CronEvidence[];
  nowMs: number;
}): ShadowLivenessResult {
  const { program, probe } = input;
  const marketJobs = scheduledJobsForMarket(program, input.market);
  const schedules = marketJobs.map((job) => {
    const row = input.cronRows.find((candidate) => candidate.jobname === job);
    return {
      job,
      schedule: row?.schedule ?? null,
      active: row?.active === true,
      found: Boolean(row),
      lastStartedAt: row?.last_started_at ?? null,
      lastStatus: row?.last_status ?? null,
    };
  });
  if ((probe.mode === "off" || probe.mode === "inert") && schedules.some((job) => job.found && job.active)) {
    return { verdict: "unexpected_schedule", note: `Program is declared ${probe.mode}, but active schedule(s) remain: ${schedules.filter((job) => job.found && job.active).map((job) => job.job).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
  }
  const expectedJobs = probe.mode === "off" || probe.mode === "inert" ? [] : schedules;
  if (expectedJobs.some((job) => !job.found)) {
    return { verdict: "missing_schedule", note: `Registry schedule is absent: ${expectedJobs.filter((job) => !job.found).map((job) => job.job).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
  }
  if (expectedJobs.some((job) => !job.active)) {
    return { verdict: "inactive_schedule", note: `Expected collector schedule is inactive: ${expectedJobs.filter((job) => !job.active).map((job) => job.job).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
  }
  if (expectedJobs.some((job) => job.lastStatus != null && !["succeeded", "running"].includes(job.lastStatus))) {
    const failed = expectedJobs.filter((job) => job.lastStatus != null && !["succeeded", "running"].includes(job.lastStatus));
    return { verdict: "failed_schedule_run", note: `Latest scheduled invocation failed: ${failed.map((job) => `${job.job}=${job.lastStatus}`).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
  }
  const expectedRunIdleHours = probe.expectedRunIdleHours;
  if (expectedRunIdleHours != null) {
    const neverRun = expectedJobs.filter((job) => job.lastStartedAt == null);
    if (neverRun.length) return { verdict: "never_run", note: `Active schedule has no recorded invocation yet: ${neverRun.map((job) => job.job).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
    const staleRuns = expectedJobs.filter((job) => input.nowMs - Date.parse(job.lastStartedAt!) > expectedRunIdleHours * 3_600_000);
    if (staleRuns.length) return { verdict: "stale_schedule_run", note: `Latest scheduled invocation is outside ${expectedRunIdleHours}h for: ${staleRuns.map((job) => job.job).join(", ")}.`, schedules, lastWrite: input.lastWrite, idleHours: null };
  }

  if (probe.mode === "off" || probe.mode === "inert") {
    return {
      verdict: "expected_empty",
      note: probe.mode === "off" ? `Program is intentionally off. ${probe.note}` : `Program is an inert foundation. ${probe.note}`,
      schedules, lastWrite: input.lastWrite, idleHours: null,
    };
  }
  if (input.count == null) return { verdict: "unknown", note: "Evidence query failed; collection health cannot be proven.", schedules, lastWrite: input.lastWrite, idleHours: null };
  if (input.count === 0 || !input.lastWrite) {
    const waiting = probe.mode === "event_driven";
    return {
      verdict: waiting ? "waiting_for_input" : "empty",
      note: waiting ? `No qualifying event has written evidence. ${probe.note}` : `No evidence rows exist despite an expected scheduled producer. ${probe.note}`,
      schedules, lastWrite: input.lastWrite, idleHours: null,
    };
  }
  const parsed = Date.parse(input.lastWrite);
  if (!Number.isFinite(parsed)) return { verdict: "unknown", note: "Latest evidence timestamp is invalid.", schedules, lastWrite: input.lastWrite, idleHours: null };
  const idleHours = Math.max(0, (input.nowMs - parsed) / 3_600_000);
  if (probe.mode === "event_driven" && probe.expectedIdleHours == null) {
    return { verdict: "waiting_for_input", note: `Prior evidence exists, but this event-driven path has no time-based write promise; a past row is not proof of current eligible input. ${probe.note}`, schedules, lastWrite: input.lastWrite, idleHours };
  }
  const expected = probe.expectedIdleHours;
  if (expected == null) return { verdict: "unknown", note: "Probe lacks a freshness bound.", schedules, lastWrite: input.lastWrite, idleHours };
  if (idleHours > expected * 3) return { verdict: "frozen", note: `No evidence for ${Math.floor(idleHours)}h; expected a write within ${expected}h. ${probe.note}`, schedules, lastWrite: input.lastWrite, idleHours };
  if (idleHours > expected) return { verdict: "stale", note: `Evidence is ${Math.floor(idleHours)}h old, beyond the ${expected}h freshness bound. ${probe.note}`, schedules, lastWrite: input.lastWrite, idleHours };
  return { verdict: "live", note: `Evidence is within its ${expected}h freshness bound. ${probe.note}`, schedules, lastWrite: input.lastWrite, idleHours };
}
