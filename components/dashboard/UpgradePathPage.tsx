"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Database, GitCommitHorizontal, RefreshCw, ShieldCheck } from "lucide-react";
import type { ShadowProgramStatus } from "@/lib/shadows/status";
import type { ShadowLifecycle } from "@/lib/shadows/registry";
import type { CompletionAssessment } from "@/lib/shadows/completion";
import { MARKET_LABEL, useMarket } from "@/lib/market-context";
import { isRealIsoDate } from "@/lib/date-only";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#2B2F3D",
  text: "#ECEDEF", textSub: "#A8ABB6", muted: "#727786", accent: "#7C83FD",
  green: "#34D399", red: "#F87171", yellow: "#FBBF24", blue: "#60A5FA",
};

type ApiResponse = {
  generatedAt: string;
  build: { environment: string; commit: string | null };
  market: "us" | "india";
  summary: {
    total: number; collecting: number; readyForReview: number; blockedOrIdle: number; trackedCalls7d: number;
    attribution?: { performanceEligible: number; measured: number; syntheticMeasured: number; collecting: number; producerMissing: number; invalid: number; notAttributable: number };
    completion?: { applicable: number; repair: number; buildComparison: number; collecting: number; results: number; parked: number; overdue: number };
  };
  snapshotLedger: { state: "available" | "unavailable"; reason: string | null };
  programs: Array<ShadowProgramStatus & { resultHref?: string | null; completion?: CompletionAssessment; shadowBookSnapshot: ShadowBookSnapshot; producerRun?: {
    state: string; status?: string; started_at?: string; finished_at?: string | null;
    expected_session?: string | null; observed_session?: string | null; trigger_source?: string;
    blockers?: string[]; code_version?: string | null; note?: string;
    details?: {
      evidenceType?: string; resultCount?: number; resultStates?: Record<string, number>; persisted?: boolean;
      asOfDate?: string | null; performanceAttribution?: string; collectionState?: string;
      market?: "us" | "india"; accountConfigured?: boolean; marketOpen?: boolean | null;
      fillRowsRead?: number; accountMatchedFillRows?: number; accountMatchedBuyFills?: number;
      accountMatchedSellFills?: number; reconstructedPositions?: number; positionsChecked?: number;
      quotesUnavailable?: number; shadowRowsWritten?: number; stateWriteFailures?: number; shadowWriteFailures?: number;
    };
  } }>;
  collection?: Array<{
    id: string;
    market: "us" | "india";
    verdict: string;
    note: string;
    last_write: string | null;
    rows?: number | null;
    market_scope?: string;
    schedules?: Array<{ job: string; schedule: string | null; active: boolean; found?: boolean; lastStartedAt?: string | null; lastStatus?: string | null }>;
  }>;
};
type ShadowBookSnapshot =
  | { state: "not_attributable" | "none" | "unavailable"; note: string }
  | {
      state: "captured";
      sessionDate: string;
      windowStart: string;
      programVersion: string;
      baselineVersion: string;
      baselineReturnPct: number;
      variantReturnPct: number;
      benchmarkReturnPct: number;
      netDeltaPct: number;
      benchmarkRelativeDeltaPct: number;
      baselineDrawdownPct: number;
      variantDrawdownPct: number;
      turnoverPct: number;
      independentBlocks: number;
      blockers: string[];
    };
type CovarianceShadowResponse = {
  market: "us" | "india";
  generatedAt: string;
  summary: {
    events: number; measured: number; unmeasurable: number; riskTrimmed: number;
    averageSizeReductionPct: number | null; averageBaselineDailyVolPct: number | null;
    averageCounterfactualDailyVolPct: number | null;
  };
  events: Array<{
    symbol: string; state: string; reason: string | null; createdAt: string; decisionAt: string | null; signalId: string | null;
    baselineSizePct: number | null; counterfactualSizePct: number | null;
    baselineDailyVolPct: number | null; counterfactualDailyVolPct: number | null;
    maxPortfolioDailyVolPct: number | null; sizeReductionPct: number | null;
    commonSessions: number | null; firstSession: string | null; lastSession: string | null;
    priceBasis: string | null; shrinkage: number | null;
  }>;
  boundary: string;
};
type LifecycleFilter = "all" | "active" | "review" | "blocked" | "off" | "repair" | "build";

const LIFECYCLE_META: Record<ShadowLifecycle, { label: string; color: string }> = {
  collecting: { label: "Collecting", color: T.blue },
  ready_for_review: { label: "Analysis available", color: T.blue },
  blocked: { label: "Blocked", color: T.red },
  armed: { label: "Armed", color: T.yellow },
  paper_active: { label: "Paper active", color: T.green },
  idle: { label: "Idle", color: T.yellow },
  off: { label: "Off", color: T.muted },
  not_applicable: { label: "Not applicable", color: T.muted },
};
const BENEFIT_META = {
  benefited: { label: "Benefited", color: T.green },
  promising: { label: "Promising", color: T.green },
  mixed: { label: "Mixed", color: T.yellow },
  not_beneficial: { label: "Not beneficial", color: T.red },
  insufficient: { label: "Insufficient evidence", color: T.yellow },
  operational_only: { label: "Operational proof only", color: T.blue },
};
const DEPLOYMENT_META = {
  production_measurement: { label: "Production · measure-only", color: T.blue },
  production_paper: { label: "Production · paper impact", color: T.green },
  production_blocked: { label: "Production · blocked", color: T.red },
  scheduled_idle: { label: "Production schedule · idle", color: T.red },
  deployed_inactive: { label: "Deployed · inactive", color: T.muted },
  not_applicable: { label: "Not applicable", color: T.muted },
  status_unavailable: { label: "Production status unknown", color: T.red },
};
const ATTRIBUTION_META = {
  measured: { label: "Measured", color: T.green },
  collecting: { label: "Collecting", color: T.yellow },
  producer_missing: { label: "Producer missing", color: T.red },
  not_attributable: { label: "Not attributable", color: T.blue },
  invalid: { label: "Invalid", color: T.red },
};
const COLLECTION_META: Record<string, { label: string; color: string }> = {
  live: { label: "Evidence fresh", color: T.green },
  waiting_for_input: { label: "Waiting for eligible input", color: T.yellow },
  expected_empty: { label: "Intentionally off / scaffold", color: T.muted },
  stale: { label: "Evidence stale", color: T.yellow },
  frozen: { label: "Evidence frozen", color: T.red },
  empty: { label: "Scheduled writer has no rows", color: T.red },
  missing_schedule: { label: "Schedule missing", color: T.red },
  inactive_schedule: { label: "Schedule inactive", color: T.red },
  unexpected_schedule: { label: "Unexpected active schedule", color: T.red },
  never_run: { label: "Schedule has never run", color: T.red },
  failed_schedule_run: { label: "Latest scheduled run failed", color: T.red },
  stale_schedule_run: { label: "Scheduled run stale", color: T.red },
  unknown: { label: "Collection unverified", color: T.yellow },
};

function useIsMobile(breakpoint = 900) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [breakpoint]);
  return mobile;
}

function fmtNumber(value: number | null) {
  return value == null ? "Not metered" : new Intl.NumberFormat("en-US").format(value);
}
function fmtDate(value: string | null) {
  if (!value) return "No evidence yet";
  if (isRealIsoDate(value)) return `${value} · session`;
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function fmtPct(value: number | null) {
  return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function etaLabel(program: ShadowProgramStatus) {
  if (program.lifecycle === "not_applicable") return "Not applicable";
  if (program.progress.target != null && program.progress.completed >= program.progress.target) return "Evidence floor met";
  if (program.progress.estimatedDays == null) return "No defensible ETA";
  return `About ${program.progress.estimatedDays} day${program.progress.estimatedDays === 1 ? "" : "s"}`;
}

function StatusPill({ label, color }: { label: string; color: string }) {
  return <span style={{
    display: "inline-flex", alignItems: "center", minHeight: "24px", padding: "3px 8px",
    borderRadius: "6px", border: `1px solid ${color}55`, color, background: `${color}12`,
    fontSize: "11px", fontWeight: 700,
  }}>{label}</span>;
}
function SectionLabel({ icon, text }: { icon: React.ReactNode; text: string }) {
  return <div style={{
    display: "flex", alignItems: "center", gap: "6px", color: T.muted, fontSize: "11px",
    fontWeight: 750, textTransform: "uppercase", marginBottom: "7px",
  }}>{icon}{text}</div>;
}
function TextBlock({ label, text }: { label: string; text: string }) {
  return <div>
    <div style={{ color: T.muted, fontSize: "11px", fontWeight: 750, textTransform: "uppercase", marginBottom: "5px" }}>{label}</div>
    <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{text}</div>
  </div>;
}
function ProgressBar({ program }: { program: ShadowProgramStatus }) {
  if (!program.available) return <div style={{ color: T.yellow, fontSize: 12 }}>Evidence unavailable · no count or readiness inferred.</div>;
  const target = program.progress.target;
  const pct = target == null ? null : Math.min(100, Math.round((program.progress.completed / Math.max(1, target)) * 100));
  return <div>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", marginBottom: "7px" }}>
      <span style={{ color: T.text, fontSize: "13px", fontWeight: 650 }}>
        {fmtNumber(program.progress.completed)}{target == null ? "" : ` / ${fmtNumber(target)}`} {program.progress.unit}
      </span>
      <span style={{ color: T.textSub, fontSize: "12px" }}>{etaLabel(program)}</span>
    </div>
    {pct != null && <div style={{ height: "6px", background: T.surface, borderRadius: "3px", overflow: "hidden" }}>
      <div style={{ width: `${pct}%`, height: "100%", background: pct >= 100 ? T.green : T.accent }} />
    </div>}
    <div style={{ color: T.muted, fontSize: "12px", marginTop: "7px" }}>
      {program.progress.ratePerDay == null ? "No observed collection rate" : `${program.progress.ratePerDay.toFixed(2)} per day over ${program.progress.windowDays} days`}
    </div>
    {program.progress.secondary && <div style={{ color: T.textSub, fontSize: "12px", marginTop: "5px" }}>
      Secondary gate: {program.progress.secondary.completed} / {program.progress.secondary.target} {program.progress.secondary.unit}
    </div>}
  </div>;
}

function ProgramPanel({ program, mobile, market, collection }: {
  program: ApiResponse["programs"][number];
  mobile: boolean;
  market: "us" | "india";
  collection?: ApiResponse["collection"] extends (infer T)[] | undefined ? T : never;
}) {
  const lifecycle = LIFECYCLE_META[program.lifecycle];
  const benefit = BENEFIT_META[program.benefitVerdict];
  const deployment = DEPLOYMENT_META[program.deployment.state];
  const attribution = ATTRIBUTION_META[program.attribution.state];
  return <section id={`upgrade-${program.id}`} style={{ scrollMarginTop: 20, background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", overflow: "hidden", opacity: program.available ? 1 : 0.72 }}>
    {program.completion && <div style={{ padding: "14px 20px", background: T.surface, borderBottom: `1px solid ${T.border}`, fontSize: 12, lineHeight: 1.6 }}>
      <strong style={{ color: program.completion.priority === 0 ? T.red : T.accent }}>{program.completion.title}</strong>
      <div style={{ color: T.textSub }}>{program.completion.reason}</div>
      <div style={{ color: T.text }}>Next: {program.completion.nextAction}</div>
      {program.resultHref && <a href={program.resultHref} style={{ display: "inline-block", color: T.blue, padding: "8px 0" }}>Open full evaluator results →</a>}
      <div style={{ color: program.completion.overdue ? T.yellow : T.muted }}>Owner: {program.completion.owner} · Review: {program.completion.reviewDate ?? "Not scheduled"}{program.completion.overdue ? " · overdue" : ""} · No automatic activation</div>
    </div>}
    <div style={{
      padding: mobile ? "16px" : "18px 20px", display: "flex", justifyContent: "space-between",
      alignItems: "flex-start", gap: "16px", borderBottom: `1px solid ${T.border}`,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: "17px", lineHeight: 1.3, margin: 0, color: T.text }}>{program.name}</h2>
          <StatusPill label={lifecycle.label} color={lifecycle.color} />
          <StatusPill label={benefit.label} color={benefit.color} />
          <StatusPill label={`Attribution · ${attribution.label}`} color={attribution.color} />
          <StatusPill label={deployment.label} color={deployment.color} />
        </div>
        <div style={{ color: T.muted, fontSize: "12px", marginTop: "7px" }}>
          {program.category} · {market.toUpperCase()} view · Supports: {program.markets.map((supported) => supported.toUpperCase()).join(" + ")} · Owner: {program.owner}
        </div>
      </div>
      <div style={{ color: T.textSub, fontSize: "12px", whiteSpace: "nowrap" }}>Latest: {fmtDate(program.latestAt)}</div>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1.25fr) minmax(280px, .75fr)" }}>
      <div style={{ padding: mobile ? "16px" : "18px 20px", borderRight: mobile ? "none" : `1px solid ${T.border}` }}>
        <div style={{ color: T.text, fontSize: "14px", lineHeight: 1.55 }}>{program.purpose}</div>
        <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: "14px 20px" }}>
          <TextBlock label="What it gives the app" text={program.productBenefit} />
          <TextBlock label="What it gives the trader" text={program.traderBenefit} />
          <TextBlock label="Current influence" text={program.currentInfluence} />
          <TextBlock label="Maximum allowed influence" text={program.maximumInfluence} />
        </div>
        <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
          <TextBlock label="Observed benefit" text={program.benefitEvidence} />
        </div>
        {program.details.length > 0 && <div style={{ marginTop: "12px", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: "6px", background: T.surface }}>
          <SectionLabel icon={<Database size={14} />} text="Evidence notes" />
          {program.details.map((detail, index) => <div key={`${index}-${detail}`} style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, marginTop: index === 0 ? "0" : "5px" }}>
            {detail}
          </div>)}
        </div>}
        <div style={{ marginTop: "12px", padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: "6px", background: T.surface }}>
          <SectionLabel icon={<Activity size={14} />} text="Producer liveness · not performance evidence" />
          {program.producerRun && ["running", "collected", "blocked", "error", "stale"].includes(program.producerRun.state) ? <>
            <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5 }}>
              Latest run: <span style={{ color: program.producerRun.state === "error" || program.producerRun.state === "stale" ? T.red : program.producerRun.state === "blocked" ? T.yellow : program.producerRun.state === "collected" ? T.green : T.blue }}>{program.producerRun.state}</span> · started {fmtDate(program.producerRun.started_at ?? null)} · {program.producerRun.trigger_source ?? "trigger unknown"}
              {program.producerRun.expected_session ? ` · expected ${program.producerRun.expected_session}` : ""}
              {program.producerRun.observed_session ? ` · observed session ${program.producerRun.observed_session}` : ""}
            </div>
            {program.producerRun.details?.evidenceType && <div style={{ color: T.muted, fontSize: "11px", lineHeight: 1.5, marginTop: "5px" }}>
              Collector evidence: {program.producerRun.details.evidenceType} · {program.producerRun.details.resultCount ?? 0} result rows{program.producerRun.details.persisted ? " persisted" : " not confirmed persisted"}{program.producerRun.details.asOfDate ? ` · run date ${program.producerRun.details.asOfDate}` : ""}
              {program.producerRun.details.resultStates && Object.keys(program.producerRun.details.resultStates).length > 0
                ? ` · ${Object.entries(program.producerRun.details.resultStates).map(([state, count]) => `${count} ${state}`).join(", ")}` : ""}
            </div>}
            {program.producerRun.details?.collectionState && <div style={{ color: T.muted, fontSize: "11px", lineHeight: 1.5, marginTop: "5px" }}>
              Collection state: {program.producerRun.details.collectionState.replace(/_/g, " ")}
              {program.producerRun.details.reconstructedPositions != null ? ` · positions ${program.producerRun.details.reconstructedPositions}` : ""}
              {program.producerRun.details.positionsChecked != null ? ` · checked ${program.producerRun.details.positionsChecked}` : ""}
              {program.producerRun.details.quotesUnavailable != null ? ` · quotes unavailable ${program.producerRun.details.quotesUnavailable}` : ""}
              {program.producerRun.details.shadowRowsWritten != null ? ` · shadow rows ${program.producerRun.details.shadowRowsWritten}` : ""}
              {program.producerRun.details.accountMatchedBuyFills != null ? ` · matched buys ${program.producerRun.details.accountMatchedBuyFills}` : ""}
            </div>}
            {Array.isArray(program.producerRun.blockers) && program.producerRun.blockers.map((blocker: string, index: number) => <div key={`${index}-${blocker}`} style={{ color: T.yellow, fontSize: "11px", lineHeight: 1.5, marginTop: "5px" }}>• {blocker}</div>)}
          </> : <div style={{ color: program.producerRun?.state === "unavailable" ? T.red : T.muted, fontSize: "12px", lineHeight: 1.5 }}>
            {program.producerRun?.note ?? "No producer invocation has been recorded for this program and market."}
          </div>}
          {program.producerRun?.code_version && <div style={{ color: T.muted, fontSize: "10px", marginTop: "5px" }}>Code {String(program.producerRun.code_version).slice(0, 12)}</div>}
        </div>
        <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "7px" }}>
            <div style={{ color: T.muted, fontSize: "11px", fontWeight: 750, textTransform: "uppercase" }}>Causal attribution</div>
            <StatusPill label={attribution.label} color={attribution.color} />
            <span style={{ color: T.muted, fontSize: "11px" }}>{program.attribution.comparisonType.replace(/_/g, " ")}</span>
            {program.attribution.measurementScope === "synthetic_diagnostic" && <span style={{ color: T.yellow, fontSize: "11px" }}>synthetic diagnostic · not Kairos holdings</span>}
          </div>
          <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{program.attribution.reason}</div>
          {program.attribution.returnBasis === "net_only" && <div style={{ color: T.muted, fontSize: "11px", lineHeight: 1.5, marginTop: "5px" }}>
            Net-only result: source fills already include execution costs, so gross returns are unavailable and are not inferred.
          </div>}
          {program.attribution.state === "measured" && <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(3, minmax(0, 1fr))", gap: "8px 14px", marginTop: "10px" }}>
            <TextBlock label="Baseline portfolio · net" text={fmtPct(program.attribution.baselineNetReturnPct)} />
            <TextBlock label="Variant portfolio · net" text={fmtPct(program.attribution.variantNetReturnPct)} />
            <TextBlock label="Net portfolio delta" text={fmtPct(program.attribution.netIncrementalReturnPct)} />
            <TextBlock label="Vs benchmark" text={fmtPct(program.attribution.benchmarkRelativeIncrementalReturnPct)} />
            <TextBlock label={`95% interval · ${program.attribution.uncertaintyLabel ?? "paired replay estimate"}`} text={`${fmtPct(program.attribution.ciLowerPct)} to ${fmtPct(program.attribution.ciUpperPct)}`} />
            <TextBlock label="Independent return blocks" text={program.attribution.independentSessions == null ? "—" : String(program.attribution.independentSessions)} />
            <TextBlock label="Block t-statistic" text={program.attribution.tStatistic == null ? "—" : program.attribution.tStatistic.toFixed(2)} />
            <TextBlock label="Turnover" text={fmtPct(program.attribution.turnoverPct)} />
            <TextBlock label="Drawdown delta" text={fmtPct(program.attribution.drawdownDeltaPct)} />
          </div>}
          {program.attribution.asOfSession && <div style={{ color: T.muted, fontSize: "11px", marginTop: "8px" }}>
            Window: {program.attribution.windowStart ?? "—"} to {program.attribution.windowEnd ?? "—"} · As of {program.attribution.asOfSession} · {program.attribution.baselineVersion} → {program.attribution.programVersion}
          </div>}
        </div>
        {program.attribution.comparisonType !== "operational_only" && <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
          <SectionLabel icon={<Database size={14} />} text="Forward shadow-book P&L · descriptive, not promotion proof" />
          {program.shadowBookSnapshot.state !== "captured"
            ? <div style={{ color: program.shadowBookSnapshot.state === "unavailable" ? T.red : T.muted, fontSize: "12px", lineHeight: 1.55 }}>
                {program.shadowBookSnapshot.note}
              </div>
            : <>
                <div style={{ color: T.muted, fontSize: "11px", marginBottom: "9px" }}>
                  {program.shadowBookSnapshot.windowStart} through {program.shadowBookSnapshot.sessionDate} · {program.shadowBookSnapshot.baselineVersion} → {program.shadowBookSnapshot.programVersion}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr 1fr" : "repeat(3, minmax(0, 1fr))", gap: "8px 14px" }}>
                  <TextBlock label="Baseline net return" text={fmtPct(program.shadowBookSnapshot.baselineReturnPct)} />
                  <TextBlock label="Variant net return" text={fmtPct(program.shadowBookSnapshot.variantReturnPct)} />
                  <TextBlock label="Variant − baseline" text={fmtPct(program.shadowBookSnapshot.netDeltaPct)} />
                  <TextBlock label="Benchmark return" text={fmtPct(program.shadowBookSnapshot.benchmarkReturnPct)} />
                  <TextBlock label="Active-return delta" text={fmtPct(program.shadowBookSnapshot.benchmarkRelativeDeltaPct)} />
                  <TextBlock label="Max drawdown · baseline / variant" text={`${fmtPct(program.shadowBookSnapshot.baselineDrawdownPct)} / ${fmtPct(program.shadowBookSnapshot.variantDrawdownPct)}`} />
                  <TextBlock label="Turnover" text={fmtPct(program.shadowBookSnapshot.turnoverPct)} />
                  <TextBlock label="Non-overlapping blocks observed" text={String(program.shadowBookSnapshot.independentBlocks)} />
                </div>
                {program.shadowBookSnapshot.blockers.map((blocker) => <div key={blocker} style={{ color: T.yellow, fontSize: "11px", lineHeight: 1.5, marginTop: "7px" }}>• {blocker}</div>)}
              </>}
        </div>}
      </div>
      <div style={{ padding: mobile ? "16px" : "18px 20px", display: "flex", flexDirection: "column", gap: "17px" }}>
        <div><SectionLabel icon={<Activity size={14} />} text="Evidence progress" /><ProgressBar program={program} /></div>
        <div>
          <SectionLabel icon={<Database size={14} />} text="Provider calls" />
          <div style={{ color: T.text, fontSize: "13px", lineHeight: 1.55 }}>
            {program.calls.mode === "tracked"
              ? `${fmtNumber(program.calls.recorded)} ledger rows · ${fmtNumber(program.calls.networkAttempts)} network · ${fmtNumber(program.calls.cacheHits)} cache hits`
              : program.calls.mode === "zero_incremental" ? "Zero incremental provider calls"
                : program.calls.mode === "not_applicable" ? "Not applicable" : "Not fully metered"}
          </div>
          <div style={{ color: T.muted, fontSize: "12px", lineHeight: 1.5, marginTop: "4px" }}>{program.calls.note}</div>
        </div>
        <div>
          <SectionLabel icon={<Clock3 size={14} />} text="Collection health · not P&L proof" />
          {collection && <div style={{ marginBottom: "8px" }}>
            <StatusPill label={COLLECTION_META[collection.verdict]?.label ?? collection.verdict} color={COLLECTION_META[collection.verdict]?.color ?? T.yellow} />
            <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, marginTop: "6px" }}>{collection.note}</div>
            <div style={{ color: T.muted, fontSize: "11px", marginTop: "4px" }}>
              Latest source row: {fmtDate(collection.last_write)}{collection.market_scope === "shared_evidence" ? " · shared across markets; not an independent market-local writer" : collection.market_scope === "market_and_global_context" ? " · selected market plus shared global context; not independent market evidence" : collection.market_scope === "single_market" ? " · only this market is in scope" : ""}
              {collection.rows != null && <div>{fmtNumber(collection.rows)} total persisted source rows · not independent samples; analysis previews may use a smaller declared window.</div>}
            </div>
          </div>}
          {!collection && <div style={{ color: T.yellow, fontSize: "12px", marginBottom: "8px" }}>Collection status could not be verified.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {!(collection?.schedules?.length ?? program.schedules.length) && <span style={{ color: T.muted, fontSize: "12px" }}>Event-driven or invoked inside another agent flow.</span>}
            {(collection?.schedules ?? program.schedules).map((schedule) => <div key={schedule.job} style={{ color: schedule.active ? T.textSub : T.muted, fontSize: "12px", lineHeight: 1.4 }}>
              <span style={{ color: schedule.active ? T.green : T.red }}>●</span>{" "}
              {schedule.job} · {schedule.active ? schedule.schedule ?? "active" : "not scheduled"}
              {"lastStatus" in schedule && ` · last run ${schedule.lastStatus ?? "never"}`}
            </div>)}
          </div>
        </div>
      </div>
    </div>
    <div style={{
      padding: mobile ? "16px" : "16px 20px", display: "grid",
      gridTemplateColumns: mobile ? "1fr" : "minmax(0, 1fr) minmax(0, 1fr)",
      gap: "16px 24px", borderTop: `1px solid ${T.border}`, background: T.surface,
    }}>
      <div>
        <SectionLabel icon={<GitCommitHorizontal size={14} />} text="Mainline and production" />
        <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>
          Entered mainline {program.mainline.enteredAt} at <span style={{ color: T.text }}>{program.mainline.commit}</span> · {program.mainline.implementationScope.replace(/_/g, " ")}.
        </div>
        <div style={{ color: T.muted, fontSize: "12px", lineHeight: 1.55, marginTop: "5px" }}>Why: {program.mainline.reason}</div>
        <div style={{ color: deployment.color, fontSize: "12px", lineHeight: 1.55, marginTop: "7px" }}>{program.deployment.summary}</div>
        {program.deployment.proof.map((item) => <div key={item} style={{ color: T.muted, fontSize: "11px", lineHeight: 1.45, marginTop: "3px" }}>• {item}</div>)}
      </div>
      <div>
        <SectionLabel icon={<ShieldCheck size={14} />} text="Activation gate and safety" />
        <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.55 }}>{program.activationGate}</div>
        <div style={{ color: T.muted, fontSize: "12px", lineHeight: 1.55, marginTop: "5px" }}>{program.safetyBoundary}</div>
      </div>
      <div>
        <SectionLabel icon={<AlertTriangle size={14} />} text="What remains" />
        {program.blockers.map((blocker) => <div key={blocker} style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, marginBottom: "3px" }}>• {blocker}</div>)}
        <div style={{ color: T.accent, fontSize: "12px", lineHeight: 1.5, marginTop: "7px" }}>Next: {program.nextAction}</div>
        <div style={{ color: T.yellow, fontSize: "12px", lineHeight: 1.5, marginTop: "7px" }}>Why not next stage: {program.deployment.whyNotNextStage}</div>
        <div style={{
          marginTop: "12px", padding: "8px 10px", borderRadius: "6px",
          border: `1px solid ${program.reviewDate ? T.accent : T.border}55`,
          background: program.reviewDate ? `${T.accent}0D` : T.surface,
        }}>
          <div style={{ fontSize: "10px", fontWeight: 700, textTransform: "uppercase", color: program.reviewDate ? T.accent : T.muted, marginBottom: "4px", letterSpacing: "0.08em" }}>
            Review date
          </div>
          {program.reviewDate
            ? <>
                <div style={{ color: T.text, fontSize: "13px", fontWeight: 650 }}>
                  {new Date(program.reviewDate + "T00:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                </div>
                {program.reviewNote && <div style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, marginTop: "4px" }}>{program.reviewNote}</div>}
              </>
            : <div style={{ color: T.muted, fontSize: "12px" }}>No review date set — add one before shipping.</div>
          }
        </div>
      </div>
    </div>
  </section>;
}

export default function UpgradePathPage() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [covariance, setCovariance] = useState<CovarianceShadowResponse | null>(null);
  const [covarianceError, setCovarianceError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [lifecycle, setLifecycle] = useState<LifecycleFilter>("all");
  const [queueExpanded, setQueueExpanded] = useState(false);
  const { market } = useMarket();
  const mobile = useIsMobile();
  const requestSequence = useRef(0);
  const inFlight = useRef<{ market: string; sequence: number } | null>(null);

  const load = useCallback(async () => {
    // Do not invalidate a slow response with the next polling tick or flood
    // the database with overlapping full-audit requests for the same market.
    if (inFlight.current?.market === market) return;
    const sequence = ++requestSequence.current;
    inFlight.current = { market, sequence };
    setLoading(true);
    try {
      const [response, covarianceResponse] = await Promise.all([
        fetch(`/api/upgrade-path?market=${market}`, { cache: "no-store" }),
        fetch(`/api/portfolio/covariance-shadow?market=${market}`, { cache: "no-store" }),
      ]);
      if (!response.ok) throw new Error(`Status request failed (${response.status})`);
      const next = await response.json() as ApiResponse;
      if (sequence !== requestSequence.current || next.market !== market) return;
      if (covarianceResponse.ok) {
        setCovariance(await covarianceResponse.json() as CovarianceShadowResponse);
        setCovarianceError("");
      } else {
        setCovariance(null);
        setCovarianceError(`Covariance shadow history unavailable (${covarianceResponse.status})`);
      }
      setData(next);
      setError("");
    } catch (reason) {
      if (sequence !== requestSequence.current) return;
      setError(reason instanceof Error ? reason.message : "Status request failed");
    } finally {
      if (inFlight.current?.sequence === sequence) inFlight.current = null;
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [market]);
  useEffect(() => {
    setLoading(true);
    setData(null);
    setCovariance(null);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const filtered = useMemo(() => (data?.programs ?? []).filter((program) => {
    const lifecycleMatch = lifecycle === "all"
      || (lifecycle === "active" && ["collecting", "paper_active", "armed"].includes(program.lifecycle))
      || (lifecycle === "review" && ["analysis_review", "result_review"].includes(program.completion?.state ?? ""))
      || (lifecycle === "repair" && program.completion?.state === "repair")
      || (lifecycle === "build" && program.completion?.state === "build_comparison")
      || (lifecycle === "blocked" && ["blocked", "idle"].includes(program.lifecycle))
      || (lifecycle === "off" && program.lifecycle === "off");
    return lifecycleMatch;
  }), [data, lifecycle]);
  const queue = useMemo(() => [...(data?.programs ?? [])].filter(program => program.completion && program.completion.priority <= 2)
    .sort((a, b) => a.completion!.priority - b.completion!.priority || Number(b.completion!.overdue) - Number(a.completion!.overdue) || a.name.localeCompare(b.name)), [data]);

  return <main style={{ minHeight: "100vh", background: T.bg, color: T.text, padding: mobile ? "18px 14px 36px" : "24px 28px 48px" }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "18px", marginBottom: "20px" }}>
      <div>
        <div style={{ color: T.accent, fontSize: "11px", fontWeight: 800, textTransform: "uppercase", marginBottom: "7px" }}>Research governance</div>
        <h1 style={{ fontSize: mobile ? "24px" : "28px", lineHeight: 1.2, margin: 0, letterSpacing: 0 }}>Upgrade Path</h1>
        <p style={{ color: T.textSub, fontSize: "13px", lineHeight: 1.55, margin: "8px 0 0", maxWidth: "780px" }}>
          {MARKET_LABEL[data?.market ?? market]} evidence, cost, benefit and activation boundaries for every registered shadow, paper experiment and dormant upgrade path.
        </p>
        <p style={{ color: T.yellow, fontSize: "12px", lineHeight: 1.5, margin: "7px 0 0", maxWidth: "780px" }}>
          Collection, analysis and portfolio benefit are separate. An analysis floor is not permission to enable. Missing comparisons need implementation—not endless data collection. Negative results are useful; guaranteed improvement is not promised.
        </p>
      </div>
      <button type="button" onClick={load} disabled={loading} aria-busy={loading} title="Refresh status" aria-label="Refresh status" style={{
        width: "36px", height: "36px", borderRadius: "6px", border: `1px solid ${T.border}`,
        background: T.card, color: T.text, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0,
      }}><RefreshCw size={16} /></button>
    </header>

    {data && <section style={{
      display: "grid", gridTemplateColumns: mobile ? "repeat(2, minmax(0, 1fr))" : "repeat(5, minmax(0, 1fr))",
      border: `1px solid ${T.border}`, borderRadius: "8px", overflow: "hidden", marginBottom: "16px",
    }}>
      {[
        ["Applicable", data.summary.completion?.applicable ?? data.summary.total],
        ["Repair pipeline", data.summary.completion?.repair ?? data.summary.blockedOrIdle],
        ["Missing assessment", data.summary.completion?.buildComparison ?? 0],
        ["Results to review", data.summary.completion?.results ?? data.summary.readyForReview],
        ["Collecting evidence", data.summary.completion?.collecting ?? data.summary.collecting],
      ].map(([label, value], index) => <div key={String(label)} style={{
        padding: "14px 16px", background: T.surface,
        borderRight: index === 4 || (mobile && index % 2 === 1) ? "none" : `1px solid ${T.border}`,
        borderBottom: mobile && index < 4 ? `1px solid ${T.border}` : "none",
      }}>
        <div style={{ fontSize: "20px", fontWeight: 750, color: T.text }}>{value}</div>
        <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px", textTransform: "uppercase" }}>{label}</div>
      </div>)}
    </section>}

    {data?.summary.attribution && <div style={{ margin: "-6px 0 18px", padding: "11px 13px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.textSub, fontSize: 12, lineHeight: 1.5 }}>
      <b style={{ color: T.text }}>Portfolio attribution</b> · {data.summary.attribution.measured}/{data.summary.attribution.performanceEligible} performance-eligible paths measured ({data.summary.attribution.syntheticMeasured} synthetic diagnostic, not Kairos holdings) · {data.summary.attribution.collecting} collecting · {data.summary.attribution.producerMissing} producer missing · {data.summary.attribution.invalid} invalid. <span style={{ color: T.muted }}>{data.summary.attribution.notAttributable} operational-only paths are excluded. This is separate from “Review ready,” which reflects each program’s operational evidence gate.</span>
    </div>}

    {data?.summary.completion && <section aria-label="Prioritized completion queue" style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 18 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 17 }}>Next actions · {MARKET_LABEL[data.market]}</h2>
      <p style={{ color: T.textSub, fontSize: 12, lineHeight: 1.5 }}>Repair broken evidence first, connect missing comparisons next, then review results. {data.summary.completion.parked} intentionally inactive; {data.summary.completion.overdue} past their recorded review date. Inactive and inapplicable items are not presented as experiments making progress.</p>
      {queue.slice(0, queueExpanded ? queue.length : 6)
        .map(program => <a key={program.id} href={`#upgrade-${program.id}`} onClick={() => setLifecycle("all")} style={{ display: "block", color: T.text, padding: "12px 0", borderTop: `1px solid ${T.border}`, textDecoration: "none", fontSize: 12, lineHeight: 1.55 }}>
          <strong style={{ color: program.completion!.priority === 0 ? T.red : T.accent }}>{program.name} · {program.completion!.title}</strong>
          <div>{program.completion!.nextAction}</div>
          <div style={{ color: T.muted }}>Owner: {program.completion!.owner} · Review: {program.completion!.reviewDate ?? "Not scheduled"}{program.completion!.overdue ? " · overdue" : ""}</div>
        </a>)}
      {queue.length > 6 && <button type="button" aria-expanded={queueExpanded} onClick={() => setQueueExpanded(value => !value)} style={{ padding: "9px 12px", border: `1px solid ${T.border}`, background: T.card, color: T.blue, borderRadius: 6, cursor: "pointer", marginTop: 8 }}>{queueExpanded ? "Show first 6 actions" : `Show all ${queue.length} actions`}</button>}
      {data.summary.completion.repair + data.summary.completion.buildComparison + data.summary.completion.results === 0 && <p style={{ color: T.textSub, fontSize: 12 }}>No repair or result-review action is currently reported. Collectors still have to satisfy their declared evidence gates.</p>}
    </section>}

    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: mobile ? "15px" : "18px 20px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: "16px", margin: 0, color: T.text }}>Covariance-aware sizing · shadow</h2>
          <p style={{ color: T.textSub, fontSize: "12px", lineHeight: 1.5, margin: "6px 0 0", maxWidth: "850px" }}>
            Point-in-time, same-market daily returns estimate portfolio volatility. The counterfactual can only trim the constructor’s candidate size; it is not an order instruction and does not claim higher returns.
          </p>
        </div>
        <StatusPill label="Measure only · orders unchanged" color={T.blue} />
      </div>
      {covarianceError ? <div style={{ color: T.yellow, fontSize: "12px", marginTop: "12px" }}>{covarianceError}. Existing evidence is not treated as current.</div>
        : !covariance || covariance.summary.events === 0 ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "12px" }}>No covariance-sizing decisions have been logged in the last 30 days. Evidence begins when the market-local paper trader evaluates a candidate.</div>
          : <>
            <div style={{ display: "grid", gridTemplateColumns: mobile ? "repeat(2, minmax(0, 1fr))" : "repeat(5, minmax(0, 1fr))", gap: "8px", marginTop: "14px" }}>
              {[
                ["Decisions · 30d", String(covariance.summary.events)],
                ["Measurable", String(covariance.summary.measured)],
                ["Insufficient data", String(covariance.summary.unmeasurable)],
                ["Would trim", String(covariance.summary.riskTrimmed)],
                ["Mean size trim", fmtPct(covariance.summary.averageSizeReductionPct)],
              ].map(([label, value]) => <div key={label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "10px 11px" }}>
                <div style={{ color: T.text, fontSize: "16px", fontWeight: 750 }}>{value}</div>
                <div style={{ color: T.muted, fontSize: "10px", marginTop: "3px", textTransform: "uppercase" }}>{label}</div>
              </div>)}
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", color: T.textSub, fontSize: "12px", marginTop: "10px" }}>
              <span>Mean estimated daily volatility: {fmtPct(covariance.summary.averageBaselineDailyVolPct)} → {fmtPct(covariance.summary.averageCounterfactualDailyVolPct)}</span>
              <span>Latest capture: {fmtDate(covariance.events[0]?.createdAt ?? null)}</span>
            </div>
            <div style={{ overflowX: "auto", marginTop: "12px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: "720px", fontSize: "11px" }}>
                <thead><tr>{["Symbol", "State / reason", "Base → shadow size", "Daily vol · base → shadow", "Shared sessions · basis", "Decision"].map((heading) => <th key={heading} style={{ color: T.muted, textAlign: "left", padding: "8px 7px", borderBottom: `1px solid ${T.border}`, fontWeight: 700 }}>{heading}</th>)}</tr></thead>
                <tbody>{covariance.events.slice(0, 12).map((event, index) => <tr key={`${event.signalId ?? event.symbol}-${event.createdAt}-${index}`}>
                  <td style={{ color: T.text, padding: "8px 7px", borderBottom: `1px solid ${T.border}66`, fontWeight: 700 }}>{event.symbol}</td>
                  <td style={{ color: event.state === "measured" ? T.green : T.yellow, padding: "8px 7px", borderBottom: `1px solid ${T.border}66` }}>{event.state === "measured" ? (event.reason ? `Measured · ${event.reason.replaceAll("_", " ")}` : "Measured") : event.reason ?? "Unmeasurable"}</td>
                  <td style={{ color: T.textSub, padding: "8px 7px", borderBottom: `1px solid ${T.border}66` }}>{fmtPct(event.baselineSizePct)} → {fmtPct(event.counterfactualSizePct)}</td>
                  <td style={{ color: T.textSub, padding: "8px 7px", borderBottom: `1px solid ${T.border}66` }}>{fmtPct(event.baselineDailyVolPct)} → {fmtPct(event.counterfactualDailyVolPct)}</td>
                  <td style={{ color: T.textSub, padding: "8px 7px", borderBottom: `1px solid ${T.border}66` }}>{event.commonSessions ?? "—"} · {event.priceBasis ?? "—"}</td>
                  <td style={{ color: T.muted, padding: "8px 7px", borderBottom: `1px solid ${T.border}66` }}>{fmtDate(event.createdAt)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <div style={{ color: T.muted, fontSize: "11px", lineHeight: 1.5, marginTop: "8px" }}>
              A missing or thin return panel is shown as unmeasurable, never as low risk. This panel is risk diagnostics only—not a paired portfolio P&amp;L replay or a recommendation to enable the sizing rule.
            </div>
          </>}
    </section>

    <section style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", marginBottom: "16px" }}>
      {([
         ["all", "All"], ["repair", "Repair evidence"], ["build", "Missing comparison"], ["review", "Results / analysis"], ["active", "Active"], ["blocked", "Blocked / idle"], ["off", "Off"],
      ] as const).map(([value, label]) => <button key={value} type="button" onClick={() => setLifecycle(value)} style={{
        border: `1px solid ${lifecycle === value ? T.accent : T.border}`, borderRadius: "6px",
        background: lifecycle === value ? `${T.accent}1F` : T.surface, color: lifecycle === value ? T.text : T.textSub,
        padding: "7px 10px", fontSize: "12px", cursor: "pointer",
      }}>{label}</button>)}
      {data && <span style={{ marginLeft: mobile ? 0 : "auto", color: T.muted, fontSize: "11px" }}>
        {MARKET_LABEL[data.market]} · {data.build.environment}{data.build.commit ? ` build ${data.build.commit}` : " build unverified"} · Updated {fmtDate(data.generatedAt)} · auto-refreshes every minute
      </span>}
    </section>

    {error && <div style={{
      border: `1px solid ${T.red}66`, color: T.red, background: `${T.red}10`,
      borderRadius: "8px", padding: "12px 14px", marginBottom: "16px", fontSize: "13px",
    }}>{error}. Existing values remain visible where available.</div>}

    {loading && !data ? <div style={{ color: T.textSub, padding: "40px 0" }}>Loading live evidence ledgers...</div> : <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {filtered.map((program) => <ProgramPanel
        key={program.id}
        program={program}
        mobile={mobile}
        market={data?.market ?? market}
        collection={data?.collection?.find((row) => row.id === program.id && row.market === (data?.market ?? market))}
      />)}
      {!filtered.length && <div style={{ border: `1px solid ${T.border}`, borderRadius: "8px", padding: "30px", textAlign: "center", color: T.muted }}>No programs match these filters.</div>}
    </div>}

    <footer style={{ marginTop: "18px", color: T.muted, fontSize: "11px", lineHeight: 1.5 }}>
      <CheckCircle2 size={13} style={{ verticalAlign: "-2px", marginRight: "5px" }} />
      Read-only governance surface. Activation remains a separate owner-reviewed change.
    </footer>
  </main>;
}
