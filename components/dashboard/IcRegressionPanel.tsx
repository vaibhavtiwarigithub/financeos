"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, GitCommitHorizontal, Info } from "lucide-react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, Legend,
} from "recharts";
import { useMarket } from "@/lib/market-context";

// Stage A — score->return correlation drift, per code_version.
//
// DETECTION ONLY. This panel answers "did this dimension's rank IC change
// AFTER code_version X shipped" — never "did X cause the change". Deploys ship
// weeks apart and the market regime moves between them, so a before/after
// split on code_version is confounded by construction. Every label here says
// "changed after", never "caused by" — do not soften that when editing.

type Cell = {
  market: string; horizonDays: number; dimension: string; codeVersion: string;
  firstSeen: string; lastSeen: string; n: number; qualifyingSessions: number;
  meanIc: number | null; sd: number | null; tStat: number | null;
  ci95: [number, number] | null; pValue: number | null; effectiveObservations: number;
  classification: "insufficient_evidence" | "measured_descriptive";
  reason: string; bhSignificant?: boolean; bhQ?: number;
};
type Regression = {
  market: string; horizonDays: number; dimension: string; boundaryCodeVersion: string;
  priorCodeVersions: string[]; icBefore: number; icAfter: number; nBefore: number;
  nAfter: number; sdBefore: number; deltaInSd: number; severity: "info" | "warn" | "critical";
};
type Response = { market: string; horizons: number[]; cells: Cell[]; regressions: Regression[] };

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
function shortVersion(v: string): string {
  return v === "unknown" ? "unknown" : v.slice(0, 8);
}

export default function IcRegressionPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");
  const [horizon, setHorizon] = useState(10);
  const [dimension, setDimension] = useState("technical");
  const [showDefs, setShowDefs] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/agents/ic-regression-ledger?market=${market}&horizon=${horizon}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`IC ledger unavailable (${response.status})`);
        return response.json();
      })
      .then((body) => { if (active) { setData(body); setError(""); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "IC ledger unavailable"); });
    return () => { active = false; };
  }, [market, horizon]);

  const dimensionCells = useMemo(
    () => (data?.cells ?? [])
      .filter((c) => c.dimension === dimension && c.codeVersion !== "unknown")
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen)),
    [data, dimension],
  );

  const chart = useMemo(
    () => dimensionCells.map((c) => ({
      version: shortVersion(c.codeVersion),
      firstSeen: c.firstSeen.slice(0, 10),
      ic: c.classification === "measured_descriptive" ? c.meanIc : null,
      ciLow: c.ci95 ? c.ci95[0] : null,
      ciHigh: c.ci95 ? c.ci95[1] : null,
      n: c.n,
      insufficient: c.classification === "insufficient_evidence",
    })),
    [dimensionCells],
  );

  const availableDimensions = useMemo(
    () => [...new Set((data?.cells ?? []).map((c) => c.dimension))].sort(),
    [data],
  );

  const regressionsHere = data?.regressions ?? [];

  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px 20px", marginBottom: "24px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px", color: T.text, fontSize: "15px", fontWeight: 700 }}>
          <GitCommitHorizontal size={16} color={T.accent} /> Score-Return IC by Deploy
        </div>
        <div style={{ color: T.sub, fontSize: "12px", lineHeight: 1.55, marginTop: "6px", maxWidth: "820px" }}>
          Rank IC per code_version, so a shipped change can be checked against what the correlation looked like before
          it. This shows the IC <strong>changed after</strong> a version shipped — it cannot show the version
          <strong> caused</strong> the change. Deploys ship weeks apart and the market regime moves between them.
        </div>
      </div>
      <button onClick={() => setShowDefs((v) => !v)} style={{
        background: "transparent", color: T.sub, border: `1px solid ${T.border}`, borderRadius: "5px",
        padding: "4px 10px", fontSize: "11px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "5px",
      }}><Info size={12} /> {showDefs ? "Hide" : "What do these mean?"}</button>
    </div>

    <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center", marginTop: "14px" }}>
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {HORIZONS.map((h) => <button key={h} onClick={() => setHorizon(h)} style={{
          background: h === horizon ? T.accent : T.surface, color: h === horizon ? "#fff" : T.sub,
          border: `1px solid ${h === horizon ? T.accent : T.border}`, borderRadius: "5px",
          padding: "4px 10px", fontSize: "11px", cursor: "pointer", fontWeight: 600,
        }}>{h}d</button>)}
      </div>
      <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>
        {(availableDimensions.length ? availableDimensions : Object.keys(DIMENSION_COLOR)).map((d) => (
          <button key={d} onClick={() => setDimension(d)} style={{
            background: d === dimension ? T.surface : "transparent", color: d === dimension ? T.text : T.muted,
            border: `1px solid ${d === dimension ? T.border : "transparent"}`, borderRadius: "5px",
            padding: "3px 9px", fontSize: "11px", cursor: "pointer",
          }}>
            <span style={{ display: "inline-block", width: "7px", height: "7px", borderRadius: "2px", background: DIMENSION_COLOR[d] ?? T.accent, marginRight: "5px" }} />
            {d}
          </button>
        ))}
      </div>
    </div>

    {error ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "14px" }}>{error}. No trading behavior is affected.</div> : <>
      {regressionsHere.length > 0 && <div style={{ marginTop: "14px", display: "grid", gap: "8px" }}>
        {regressionsHere.map((r) => <div key={`${r.dimension}-${r.horizonDays}-${r.boundaryCodeVersion}`} style={{
          background: r.severity === "critical" ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)",
          border: `1px solid ${r.severity === "critical" ? "rgba(248,113,113,0.35)" : "rgba(251,191,36,0.35)"}`,
          borderRadius: "6px", padding: "10px 12px", color: T.text, fontSize: "11.5px", lineHeight: 1.55,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", fontWeight: 700, color: r.severity === "critical" ? T.red : T.amber }}>
            <AlertTriangle size={13} /> {r.market} {r.dimension} h{r.horizonDays} — IC changed after {shortVersion(r.boundaryCodeVersion)}
          </div>
          <div style={{ color: T.sub, marginTop: "4px" }}>
            {fmt(r.icBefore)} (n={r.nBefore}, {r.priorCodeVersions.length} prior versions) → {fmt(r.icAfter)} (n={r.nAfter}),
            {" "}{r.deltaInSd.toFixed(2)} historical SDs below the prior mean (SD={fmt(r.sdBefore)}). Changed AFTER this
            version, not necessarily caused by it — versions ship weeks apart and the market regime changes too.
          </div>
        </div>)}
      </div>}

      {chart.length === 0 ? <div style={{ background: T.surface, border: `1px dashed ${T.border}`, borderRadius: "6px", padding: "16px", marginTop: "14px", color: T.sub, fontSize: "11.5px" }}>
        No {dimension} code_version cells yet at {horizon}d for {market}. Labels mature on their own schedule.
      </div> : <>
        <div style={{ height: "240px", marginTop: "14px" }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 10, bottom: 4, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={T.border} vertical={false} />
              <XAxis dataKey="version" tick={{ fill: T.muted, fontSize: 9 }} stroke={T.border} interval="preserveStartEnd" />
              <YAxis tick={{ fill: T.muted, fontSize: 10 }} stroke={T.border} domain={[-1, 1]} ticks={[-1, -0.5, 0, 0.5, 1]} />
              <Tooltip
                contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", fontSize: "11px" }}
                labelStyle={{ color: T.text }}
                formatter={(value: number, name: string) => [value == null ? "—" : Number(value).toFixed(4), name]}
              />
              <Legend wrapperStyle={{ fontSize: "11px", color: T.sub }} />
              <ReferenceLine y={0} stroke={T.sub} strokeWidth={1} />
              <Line type="monotone" dataKey="ic" name="mean IC" stroke={DIMENSION_COLOR[dimension] ?? T.accent} dot={{ r: 3 }} strokeWidth={1.5} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="ciLow" name="95% CI low" stroke={T.muted} strokeDasharray="3 3" dot={false} strokeWidth={1} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="ciHigh" name="95% CI high" stroke={T.muted} strokeDasharray="3 3" dot={false} strokeWidth={1} connectNulls={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ color: T.muted, fontSize: "10.5px", lineHeight: 1.5, marginTop: "6px" }}>
          One point per code_version that shipped decisions at this horizon. X axis order is by first-seen date, not
          evenly spaced in time. Gaps are versions below the evidence floor (insufficient_evidence) and are left open,
          not interpolated.
        </div>

        <div style={{ overflowX: "auto", marginTop: "14px" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px", minWidth: "820px" }}>
            <thead>
              <tr style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {["code_version", "First seen", "n", "Mean IC", "95% CI", "nEff", "BH sig.", "Verdict"].map((head) => (
                  <th key={head} style={{ textAlign: head === "code_version" ? "left" : "right", padding: "7px 9px", borderBottom: `1px solid ${T.border}`, fontWeight: 700 }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dimensionCells.map((c) => {
                const color = c.meanIc == null ? T.muted : c.meanIc > 0 ? T.green : c.meanIc < 0 ? T.red : T.sub;
                return <tr key={c.codeVersion} style={{ borderBottom: `1px solid ${T.border}` }}>
                  <td style={{ padding: "8px 9px", color: T.text, fontFamily: "monospace", fontSize: "11px" }}>{shortVersion(c.codeVersion)}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: T.sub }}>{c.firstSeen.slice(0, 10)}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{c.n}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmt(c.meanIc)}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>
                    {c.ci95 ? `[${fmt(c.ci95[0], 3)}, ${fmt(c.ci95[1], 3)}]` : "—"}
                  </td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: T.sub, fontVariantNumeric: "tabular-nums" }}>{fmt(c.effectiveObservations, 1)}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: c.bhSignificant ? T.green : T.muted }}>{c.classification === "measured_descriptive" ? (c.bhSignificant ? "Yes" : "No") : "—"}</td>
                  <td style={{ padding: "8px 9px", textAlign: "right", color: c.classification === "insufficient_evidence" ? T.amber : T.green, fontSize: "10.5px" }}>
                    {c.classification === "insufficient_evidence" ? "Insufficient" : "Descriptive"}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      </>}

      {showDefs && <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "14px 16px", marginTop: "14px" }}>
        <div style={{ color: T.text, fontSize: "12px", fontWeight: 700, marginBottom: "10px" }}>Every column, explained</div>
        <dl style={{ margin: 0, display: "grid", gap: "9px" }}>
          {[
            ["code_version", "Deployed commit SHA recorded on each decision. Rows with no recorded code_version (~33-37% of history, measured 2026-09-08) are bucketed separately as \"unknown\" and never shown here — they could span several real deploys, so grouping them under one boundary would manufacture a false one."],
            ["Mean IC / 95% CI", "Same per-session, overlap-corrected rank IC as the Dimension Rank IC panel, computed only on this code_version's rows. The CI is the normal approximation mean ± 1.96·SD/√nEff — wide when a version shipped few sessions, which is most of them."],
            ["BH sig.", "Benjamini-Hochberg significance across every measured_descriptive cell for this market — the multiple-comparisons control. Up to ~50 versions × 6 dimensions is ~300 comparisons; uncontrolled, roughly 15 would show \"significant\" by chance alone. \"No\" does not mean nothing happened, it means this cell alone does not clear the bar once ~300 comparisons are accounted for."],
            ["Verdict", "\"Insufficient\" means this code_version's sessions never cleared the pre-declared evidence floor — no IC number is shown, not a number with no support behind it."],
          ].map(([term, def]) => <div key={term}>
            <dt style={{ color: T.text, fontSize: "11.5px", fontWeight: 650 }}>{term}</dt>
            <dd style={{ color: T.sub, fontSize: "11.5px", lineHeight: 1.55, margin: "2px 0 0 0" }}>{def}</dd>
          </div>)}
        </dl>
      </div>}
    </>}
  </section>;
}
