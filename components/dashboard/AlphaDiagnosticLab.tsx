"use client";
import { useEffect, useState } from "react";

// Alpha Diagnostic Lab — compact surface inside Portfolio performance.
//
// Renders the funnel diagnosis for ONE market at a time. Every number carries
// its independent-date count and status, and a test below its evidence floor
// renders "insufficient evidence" rather than a directional verdict — the whole
// point of the feature is that a confident-looking number on 20 overlapping
// windows is what got us here.
//
// Read-only. Mounting this cannot trigger a run; POST is owner/cron only.

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

type Status = "pass" | "fail" | "insufficient_evidence" | "data_invalid" | "descriptive_only";

interface Finding {
  testId: string;
  cohort: string;
  status: Status;
  reason: string;
  coverage: number;
  sample: { nRows: number; nDates: number; nSymbols: number; horizonDays?: number; dateUnit?: string };
  metrics: Record<string, any>;
}

interface RunSummary {
  schemaVersion: number;
  status: string;
  objective: string;
  benchmark: string;
  accountingCohort: { closedLots: number };
  learningCohort: { closedLots: number; excluded: number };
  tests: Record<string, Finding>;
  verdict: string;
}

interface Run {
  id: number;
  market: string;
  started_at: string;
  completed_at: string | null;
  result_summary: RunSummary | null;
  run_fingerprint: string | null;
  code_version: string | null;
}

const STATUS_STYLE: Record<Status, { color: string; label: string }> = {
  pass: { color: T.green, label: "pass" },
  fail: { color: T.red, label: "fail" },
  data_invalid: { color: T.red, label: "data invalid" },
  insufficient_evidence: { color: T.muted, label: "insufficient evidence" },
  descriptive_only: { color: T.amber, label: "descriptive only" },
};

const TEST_TITLES: Record<string, string> = {
  A0: "Data truth", A1: "Alpha funnel", A2: "Eligible-long selection", A2_ALL_SCORED: "All-scored context",
  A3: "Payoff geometry", A4: "Exit paths", A5: "Sizing",
  A6: "Portfolio & cash", A7: "Cost stress", A8: "Robustness", A9: "Risk geometry",
};

function pct(v: unknown, digits = 2): string {
  return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(digits)}%` : "—";
}
function num(v: unknown, digits = 3): string {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

export default function AlphaDiagnosticLab({ market }: { market: "us" | "india" }) {
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Market is part of the request AND re-checked on the response, so a slow
    // reply for the previous market cannot paint over the current one.
    fetch(`/api/analytics/alpha-diagnostics?market=${market}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d?.error) { setError(String(d.error)); setRun(null); }
        else if (d?.market && d.market !== market) { /* stale response, drop it */ }
        else setRun(d?.latest ?? null);
        setLoading(false);
      })
      .catch(e => { if (!cancelled) { setError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [market]);

  if (loading) return <div style={{ color: T.muted, padding: 16 }}>Loading alpha diagnostics…</div>;
  if (error) return <div style={{ color: T.red, padding: 16 }}>Alpha diagnostics unavailable: {error}</div>;
  if (!run || !run.result_summary) {
    return (
      <div style={{ color: T.textSub, padding: 16, background: T.card, border: `1px solid ${T.border}`, borderRadius: 8 }}>
        No completed diagnostic run for {market.toUpperCase()} yet. This surface never
        estimates a result — it shows only what a recorded run actually measured.
      </div>
    );
  }

  const s = run.result_summary;
  const findings = Object.values(s.tests ?? {}).sort((a, b) => a.testId.localeCompare(b.testId));
  const a0 = s.tests?.A0;
  const dataInvalid = s.verdict === "data_invalid";

  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <h3 style={{ color: T.text, fontSize: 15, fontWeight: 600, margin: 0 }}>
          Alpha Diagnostic Lab · {market.toUpperCase()}
        </h3>
        <span style={{ color: T.muted, fontSize: 12 }}>
          vs {s.benchmark} · read-only · cannot change any policy
        </span>
      </div>

      {/* The verdict ceiling is owner_review by design; the Lab cannot promote. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0 14px" }}>
        <Pill label="verdict" value={s.verdict} color={dataInvalid ? T.red : s.verdict === "owner_review" ? T.green : T.muted} />
        <Pill label="accounting lots" value={String(s.accountingCohort?.closedLots ?? 0)} color={T.textSub} />
        <Pill label="learning lots" value={`${s.learningCohort?.closedLots ?? 0} (−${s.learningCohort?.excluded ?? 0} excluded)`} color={T.textSub} />
      </div>

      {dataInvalid && (
        <div style={{ background: "#2A1215", border: `1px solid ${T.red}`, borderRadius: 8, padding: 12, marginBottom: 14 }}>
          <strong style={{ color: T.red }}>Data truth failed — no result below is interpretable.</strong>
          <div style={{ color: T.textSub, fontSize: 12, marginTop: 6 }}>{a0?.reason}</div>
        </div>
      )}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
        {findings.map(f => <TestCard key={f.testId} f={f} dimmed={dataInvalid && f.testId !== "A0"} />)}
      </div>

      <div style={{ color: T.muted, fontSize: 11, marginTop: 12, lineHeight: 1.5 }}>
        Run {run.id} · {run.completed_at ? new Date(run.completed_at).toLocaleString() : "incomplete"}
        {run.run_fingerprint ? ` · fingerprint ${run.run_fingerprint}` : ""}
        {run.code_version ? ` · code ${run.code_version.slice(0, 7)}` : ""}
        <br />
        A finding marked <em>descriptive only</em> identifies where to investigate. It is not
        a recommendation, and the strongest verdict this feature can reach is
        owner review — activation stays outside it.
      </div>
    </div>
  );
}

function Pill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 999, padding: "4px 10px", fontSize: 12 }}>
      <span style={{ color: T.muted }}>{label} </span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function TestCard({ f, dimmed }: { f: Finding; dimmed: boolean }) {
  const st = STATUS_STYLE[f.status] ?? STATUS_STYLE.descriptive_only;
  const unit = f.sample.dateUnit === "entry_date" ? "entry date"
    : f.sample.dateUnit === "session" ? "session"
      : f.sample.dateUnit === "entry_vintage" ? "entry vintage"
        : "decision date";
  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`, borderRadius: 8,
      padding: 12, opacity: dimmed ? 0.45 : 1,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ color: T.text, fontSize: 13, fontWeight: 600 }}>
          {f.testId} · {TEST_TITLES[f.testId] ?? f.testId}
        </span>
        <span style={{ color: st.color, fontSize: 11, fontWeight: 600 }}>{st.label}</span>
      </div>

      <div style={{ color: T.muted, fontSize: 11, margin: "6px 0 8px" }}>
        {f.sample.nDates} distinct {unit}{f.sample.nDates === 1 ? "" : "s"} ·{" "}
        {f.sample.nRows} row{f.sample.nRows === 1 ? "" : "s"} ·{" "}
        {f.sample.nSymbols} symbol{f.sample.nSymbols === 1 ? "" : "s"} ·{" "}
        coverage {(f.coverage * 100).toFixed(0)}% · {f.cohort}
      </div>

      <TestMetrics f={f} />

      <div style={{ color: T.textSub, fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>{f.reason}</div>
    </div>
  );
}

function TestMetrics({ f }: { f: Finding }) {
  const m = f.metrics ?? {};
  const rows: [string, string][] = [];

  if (f.testId === "A0") {
    for (const inv of (m.invariants ?? []) as any[]) {
      rows.push([inv.id, inv.ok ? "ok" : `${inv.offending} session(s) failing`]);
    }
  } else if (f.testId === "A2" || f.testId === "A2_ALL_SCORED") {
    rows.push(["mean daily rank IC", num(m.rankIc)]);
    rows.push(["IC t-stat", num(m.rankIcT)]);
    rows.push(["mean quintile spread", pct(typeof m.meanQuintileSpread === "number" ? m.meanQuintileSpread * 100 : null)]);
    rows.push(["spread t-stat", num(m.quintileSpreadT)]);
    rows.push(["qualifying sessions", String(m.qualifyingSessions ?? 0)]);
  } else if (f.testId === "A3") {
    rows.push(["win rate", pct(typeof m.winRate === "number" ? m.winRate * 100 : null)]);
    rows.push(["profit factor (currency)", num(m.currencyProfitFactor)]);
    rows.push(["profit factor (%)", num(m.percentProfitFactor)]);
    if (m.allocationDivergenceObserved) rows.push(["allocation divergence", "percent PF ≥ 1; currency PF < 1"]);
    rows.push(["MFE capture", num(m.meanCaptureRatio)]);
    rows.push(["losers previously in profit", `${m.priorPositiveLosers ?? 0}`]);
  } else if (f.testId === "A4") {
    const r = m.resolutions ?? {};
    rows.push(["target first", String(r.target_first ?? 0)]);
    rows.push(["stop first", String(r.stop_first ?? 0)]);
    rows.push(["ambiguous (both touched)", String(r.ambiguous ?? 0)]);
    rows.push(["unavailable", String(r.unavailable ?? 0)]);
    rows.push(["neither touched", String(r.neither_touched ?? 0)]);
  } else if (f.testId === "A5") {
    rows.push(["notional↔return rank corr", num(m.notionalReturnRankCorrelation)]);
    rows.push(["actual P&L", num(m.actualCurrencyPnl, 2)]);
    rows.push(["equal-notional P&L", num(m.equalNotionalCurrencyPnl, 2)]);
    rows.push(["sizing cost", num(m.sizingCostCurrency, 2)]);
  } else if (f.testId === "A6") {
    rows.push(["sessions", String(m.sessions ?? 0)]);
    rows.push(["cash drag", pct(m.cashDragPp)]);
    for (const c of (m.comparisons ?? []) as any[]) {
      rows.push([`arm ${c.arm}`, `${pct(c.totalReturnPct)} · DD ${pct(c.maxDrawdownPct)}`]);
      if (c.rejections) rows.push([`${c.arm} rejections`, `${c.rejections} · ${JSON.stringify(c.rejectionReasons ?? {})}`]);
    }
  } else if (f.testId === "A7") {
    rows.push(["gross mean return", pct(m.grossMeanReturnPct)]);
    for (const l of (m.levels ?? []) as any[]) {
      rows.push([`@ ${l.roundTripBps}bps`, `${pct(l.meanNetReturnPct)} · ${l.profitableLots} profitable`]);
    }
  } else if (f.testId === "A8") {
    rows.push(["statistic", num(m.realStatistic)]);
    rows.push(["placebo p", num(m.placeboPValue, 4)]);
    rows.push(["trials", String(m.trialsConsidered ?? 0)]);
    rows.push(["adjusted alpha", num(m.adjustedAlpha, 4)]);
  } else if (f.testId === "A9") {
    rows.push(["initial reward:risk", num(m.initialOverallRewardRisk)]);
    rows.push(["current reward:risk", num(m.currentOverallRewardRisk)]);
    rows.push(["stops at/above cost", String(m.lockedProfitStops ?? 0)]);
    rows.push(["distinct target levels", String(m.distinctTargetLevels ?? 0)]);
    for (const v of (m.vintages ?? []) as any[]) {
      rows.push([`vintage ${v.vintage}`, `initial R:R ${num(v.meanInitialRewardRisk)} · ${v.lots} lot(s)`]);
    }
  } else if (f.testId === "A1") {
    for (const st of (m.stages ?? []) as any[]) {
      rows.push([st.stage, `${st.count} · mean ${pct(typeof st.meanBenchmarkNeutralReturn === "number" ? st.meanBenchmarkNeutralReturn * 100 : null)}`]);
    }
  }

  if (rows.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 3 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12 }}>
          <span style={{ color: T.muted }}>{k}</span>
          <span style={{ color: T.text, fontVariantNumeric: "tabular-nums" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
