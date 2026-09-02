"use client";

import { useEffect, useMemo, useState } from "react";
import { BarChart3, Info, ShieldCheck } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Legend,
} from "recharts";
import { useMarket } from "@/lib/market-context";
import { buildChartRows, type SessionPoint } from "@/lib/learning/dimension-ic-chart";

// Per-dimension rank IC: current state (table) and how each trading session's
// IC has actually moved (chart).
//
// WHAT IS DELIBERATELY *NOT* PLOTTED HERE. The daily diagnostic run stores
// `mean_session_rank_ic`, an EXPANDING-window average over every session to
// date. Charting that across runs draws a cumulative mean converging, not a
// signal changing: consecutive runs share ~93% of their input sessions. In
// production it read +0.1394 frozen for nine days, then oscillated as the
// truncated loader reshuffled its sample, then settled near -0.13 — a line that
// looks like "technical decayed through August" but is two bug fixes landing on
// 2026-08-28. This panel charts the PER-SESSION series instead: one point per
// trading day, which is the only object here that genuinely varies.

type Metrics = {
  cohort?: string;
  mean_session_rank_ic: number | null;
  sd_session_rank_ic?: number | null;
  t_stat?: number | null;
  positive_session_share: number | null;
  qualifying_sessions: number;
  labeled_observations: number;
  effective_observations: number;
  min_effective_observations_required: number;
  min_sessions_required: number;
  session_ic_series?: SessionPoint[];
  all_scored_context?: { mean_session_rank_ic: number | null; qualifying_sessions: number };
};
type Finding = { subject_type: string; subject_key: string; finding_type: string; classification: string; metrics: Metrics; reason: string };
type Run = { id: number; horizon_days: number; status: string; as_of_date: string; analysis_plan_version: string; created_at: string; dimension_diagnostic_findings: Finding[] };
type Response = { runs: Run[]; planVersion: string };

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

const DIMENSION_COLOR: Record<string, string> = {
  fundamental: "#6366F1", technical: "#F87171", sentiment: "#34D399",
  macro: "#FBBF24", insider: "#38BDF8",
};

const HORIZONS = [2, 5, 10, 20, 60, 120];

function fmt(value: number | null | undefined, digits = 4): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}
function pct(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(0)}%`;
}

export default function DimensionIcPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [horizon, setHorizon] = useState(5);
  const [focus, setFocus] = useState<string>("all");
  const [showDefs, setShowDefs] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/agents/dimension-diagnostics?market=${market}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Diagnostics unavailable (${response.status})`);
        return response.json();
      })
      .then((body) => { if (active) { setData(body); setError(""); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Diagnostics unavailable"); });
    return () => { active = false; };
  }, [market]);

  // Newest run for the selected horizon. The run is an expanding window, so the
  // newest one already contains every session — no cross-run stitching needed.
  const run = useMemo(
    () => (data?.runs ?? []).filter((r) => r.horizon_days === horizon)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0],
    [data, horizon],
  );

  const dimensions = useMemo(
    () => (run?.dimension_diagnostic_findings ?? [])
      .filter((f) => f.subject_type === "dimension" && f.finding_type === "predictive")
      .sort((a, b) => (b.metrics.mean_session_rank_ic ?? -Infinity) - (a.metrics.mean_session_rank_ic ?? -Infinity)),
    [run],
  );

  // Union every dimension's sessions onto one date axis. Dimensions qualify on
  // different days (availability differs), so gaps are real and left null
  // rather than interpolated — a drawn-through gap would invent an observation.
  const chart = useMemo(() => buildChartRows(
    dimensions
      .filter((f) => focus === "all" || f.subject_key === focus)
      .map((f) => ({ key: f.subject_key, points: f.metrics.session_ic_series ?? [] })),
    focus === "all" ? undefined : focus,
  ), [dimensions, focus]);

  const insufficient = dimensions.every((f) => f.classification === "insufficient_evidence");

  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px 20px", marginBottom: "24px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px", color: T.text, fontSize: "15px", fontWeight: 700 }}>
          <BarChart3 size={16} color={T.accent} /> Dimension Rank IC
        </div>
        <div style={{ color: T.sub, fontSize: "12px", lineHeight: 1.55, marginTop: "6px", maxWidth: "780px" }}>
          Does each scoring dimension rank tomorrow&apos;s winners above its losers? One IC per trading session,
          on the eligible-long cohort — the decisions that could actually have been bought.
        </div>
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: T.sub, fontSize: "11px" }}>
        <ShieldCheck size={14} color={T.green} /> Measure-only
      </div>
    </div>

    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center", marginTop: "14px" }}>
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {HORIZONS.map((h) => <button key={h} onClick={() => setHorizon(h)} style={{
          background: h === horizon ? T.accent : T.surface, color: h === horizon ? "#fff" : T.sub,
          border: `1px solid ${h === horizon ? T.accent : T.border}`, borderRadius: "5px",
          padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontWeight: 600,
        }}>{h}d</button>)}
      </div>
      <button onClick={() => setShowDefs((value) => !value)} style={{
        background: "transparent", color: T.sub, border: `1px solid ${T.border}`,
        borderRadius: "5px", padding: "4px 10px", fontSize: "11px", cursor: "pointer",
        display: "inline-flex", alignItems: "center", gap: "5px",
      }}><Info size={12} /> {showDefs ? "Hide" : "What do these mean?"}</button>
    </div>

    {error ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "14px" }}>{error}. No trading behavior is affected.</div>
      : !run ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "14px" }}>No diagnostic run yet at this horizon for this market. Labels mature on their own schedule; a {horizon}-day label needs {horizon} sessions after the decision.</div>
      : <>
        {insufficient && <div style={{ background: "rgba(251,191,36,0.08)", border: `1px solid rgba(251,191,36,0.35)`, borderRadius: "6px", padding: "10px 12px", marginTop: "14px", color: T.amber, fontSize: "11.5px", lineHeight: 1.5 }}>
          <strong>Descriptive only — no predictive conclusion is permitted at this horizon.</strong> Every dimension below sits under
          the pre-declared evidence floor of {dimensions[0]?.metrics.min_effective_observations_required ?? 12} independent
          observations. These numbers describe what happened; they are not evidence that a dimension works or fails, and they
          must not be used to justify a weight change.
        </div>}

        <div style={{ overflowX: "auto", marginTop: "14px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "760px" }}>
            <thead>
              <tr style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {["Dimension", "Mean IC", "SD", "t", "Sessions", "nEff", "Positive days", "All-scored", "Verdict"].map((head) => (
                  <th key={head} style={{ textAlign: head === "Dimension" ? "left" : "right", padding: "7px 10px", borderBottom: `1px solid ${T.border}`, fontWeight: 700 }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dimensions.map((finding) => {
                const m = finding.metrics;
                const ic = m.mean_session_rank_ic;
                const color = ic == null ? T.muted : ic > 0 ? T.green : ic < 0 ? T.red : T.sub;
                return <tr key={finding.subject_key} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: "8px 10px", color: T.text, fontWeight: 600 }}>
                    <span style={{ display: "inline-block", width: "8px", height: "8px", borderRadius: "2px", background: DIMENSION_COLOR[finding.subject_key] ?? T.accent, marginRight: "7px" }} />
                    {finding.subject_key}
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(ic)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{fmt(m.sd_session_rank_ic)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{fmt(m.t_stat, 2)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{m.qualifying_sessions}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: (m.effective_observations ?? 0) < (m.min_effective_observations_required ?? 12) ? T.amber : T.green, fontVariantNumeric: "tabular-nums" }}>
                    {fmt(m.effective_observations, 1)}<span style={{ color: T.muted }}>/{m.min_effective_observations_required}</span>
                  </td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{pct(m.positive_session_share)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: T.muted, fontVariantNumeric: "tabular-nums" }}>{fmt(m.all_scored_context?.mean_session_rank_ic)}</td>
                  <td style={{ padding: "8px 10px", textAlign: "right", color: finding.classification === "insufficient_evidence" ? T.amber : T.green, fontSize: "10.5px" }}>
                    {finding.classification === "insufficient_evidence" ? "Insufficient" : "Descriptive"}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: "flex", gap: "5px", flexWrap: "wrap", marginTop: "16px" }}>
          {["all", ...dimensions.map((f) => f.subject_key)].map((key) => <button key={key} onClick={() => setFocus(key)} style={{
            background: key === focus ? T.surface : "transparent", color: key === focus ? T.text : T.muted,
            border: `1px solid ${key === focus ? T.border : "transparent"}`, borderRadius: "5px",
            padding: "3px 9px", fontSize: "11px", cursor: "pointer",
          }}>{key === "all" ? "All dimensions" : key}</button>)}
        </div>

        {chart.length === 0 ? <div style={{ background: T.surface, border: `1px dashed ${T.border}`, borderRadius: "6px", padding: "16px", marginTop: "10px", color: T.sub, fontSize: "11.5px", lineHeight: 1.55 }}>
          <strong style={{ color: T.text }}>No per-session series on this run yet.</strong> The table above comes from a run recorded
          before the series was captured, so it has the mean but not the individual sessions behind it. The next scheduled
          diagnostic ({market === "india" ? "23:25" : "23:20"} UTC, after label maturation) writes the series and this chart
          fills in. Nothing is wrong and no trading behavior is affected — the older run is kept as recorded rather than
          rewritten, so its mean stays exactly the number that was published at the time.
        </div> : <div style={{ height: "260px", marginTop: "10px" }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 10, bottom: 4, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 10 }} stroke={T.border} minTickGap={28} />
              <YAxis tick={{ fill: T.muted, fontSize: 10 }} stroke={T.border} domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} />
              <Tooltip
                contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", fontSize: "11px" }}
                labelStyle={{ color: T.text }}
                formatter={(value: number, name: string) => [value == null ? "—" : value.toFixed(4), name]}
              />
              <Legend wrapperStyle={{ fontSize: "11px", color: T.sub }} />
              {/* Zero is the only meaningful reference: above it the dimension ranked
                  correctly that day, below it, backwards. */}
              <ReferenceLine y={0} stroke={T.sub} strokeWidth={1} />
              {(focus === "all" ? dimensions.map((f) => f.subject_key) : [focus]).map((key) => (
                <Line key={key} type="monotone" dataKey={key} stroke={DIMENSION_COLOR[key] ?? T.accent}
                  dot={false} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
              ))}
              {focus !== "all" && <Line type="monotone" dataKey="rolling" stroke={T.text} strokeWidth={2}
                strokeDasharray="4 3" dot={false} connectNulls name="rolling mean" isAnimationActive={false} />}
            </LineChart>
          </ResponsiveContainer>
        </div>}
        <div style={{ color: T.muted, fontSize: "10.5px", lineHeight: 1.5, marginTop: "6px" }}>
          One point per trading session, not per diagnostic run. Gaps are days a dimension had fewer than 5 scored
          names and are left open rather than joined — a connected gap would invent an observation. At a {horizon}-day
          horizon any {horizon} consecutive points share market data, so points must sit {horizon} sessions apart to be
          independent. Plan version {run.analysis_plan_version}; series before a plan change are not continuous with this one.
        </div>

        {showDefs && <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "14px 16px", marginTop: "14px" }}>
          <div style={{ color: T.text, fontSize: "12px", fontWeight: 700, marginBottom: "10px" }}>What each column means</div>
          <dl style={{ margin: 0, display: "grid", gap: "9px" }}>
            {[
              ["Session IC (chart point)", "One trading day's Spearman rank correlation between the dimension's scores across that day's candidates and their benchmark-neutral forward returns. +1 = ranked the day perfectly, 0 = no ordering, −1 = exactly backwards. Individually noisy; a single day means nothing."],
              ["Mean IC (table)", "Those session ICs averaged over every qualifying session to date. Averaged per DAY, not pooled per observation, so a day with 80 names does not outweigh a day with 8. Roughly 0.05 sustained is a normal-to-good equity factor; a persistent 0.15+ is more likely a bug than an edge."],
              ["SD", "Spread of the session ICs around that mean. Large SD with a small mean means the dimension is inconsistent day to day, not that it is wrong."],
              ["t", "Mean ÷ (SD ÷ √nEff): how many standard errors the mean sits from zero. Uses nEff, NOT the session count — dividing by √sessions would overstate it by √horizon and manufacture significance out of overlap. Across 5 dimensions the Šidák bar is about |t| 2.57."],
              ["Sessions", "Trading days with at least 5 scored names that had this dimension available. Differs per dimension because availability differs — insider data is far sparser than price data."],
              ["nEff (effective observations)", "Sessions ÷ horizon days. A 5-day forward return measured on consecutive days reuses the same market move roughly 5 times, so 29 sessions carry only ~5.8 independent observations. THIS is the number that decides whether a result means anything — not the observation count, which is always reassuringly large."],
              ["Positive days", "Share of sessions with IC above zero. Guards against one outlier day carrying the mean: a mean of +0.10 built on 35% positive days is a different claim than one built on 65%."],
              ["All-scored", "The same IC over every scored name, including those that were never entry-eligible and could not have been bought. Context only. It is systematically different from the headline because the eligible cohort is selected on a composite of these same dimensions — a collider that pushes component ICs apart. Never cite this column as predictive power."],
              ["Verdict", "\"Insufficient\" means the sample is below the pre-declared floor and no predictive conclusion is permitted, however the numbers look. \"Descriptive\" means the floor is cleared and the number describes history — still not validation, promotion, or a reason to change a weight."],
            ].map(([term, def]) => <div key={term}>
              <dt style={{ color: T.text, fontSize: "11.5px", fontWeight: 650 }}>{term}</dt>
              <dd style={{ color: T.sub, fontSize: "11.5px", lineHeight: 1.55, margin: "2px 0 0 0" }}>{def}</dd>
            </div>)}
          </dl>
        </div>}
      </>}
  </section>;
}
