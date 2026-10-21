"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", amber: "#FBBF24" };
type Cell = { method: string; observations: number; returnedPoints: number; sessions: number; roughWindows: number; ic: number | null; baselineIc: number | null; deltaIc: number | null; scoreRankCorrelation: number | null; descriptiveHacT: number | null; state: string; commonSampleHash: string };
type Data = { asOf: string; since: string; benchmark: string; labelVersion: string; convention: string; caveat: string; cells: Cell[]; coverage: { runs: number; forecasts: number; labelledRuns: number; missingBaseline: number; missingAvailability: number; unlabelled: number } };
const num = (v: number | null) => v == null ? "—" : v.toFixed(3);

export default function PredictionLabPanel() {
  const { market } = useMarket();
  const [horizon, setHorizon] = useState(10);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    fetch(`/api/learning/prediction-lab?market=${market}&horizon=${horizon}`, { cache: "no-store", signal: controller.signal })
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error ?? "Comparison unavailable"); return body; })
      .then(setData).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Comparison unavailable"); });
    return () => controller.abort();
  }, [market, horizon]);
  return <section id="prediction-lab" aria-label="Prediction Lab" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><h2 style={{ color: T.text, fontSize: 17, margin: 0 }}>Prediction Lab</h2><div style={{ color: T.amber, fontSize: 11, marginTop: 5 }}>RESEARCH ONLY · NO TRADING INFLUENCE</div></div>
      <div role="group" aria-label="Prediction horizon" style={{ display: "flex", gap: 5 }}>{[2, 5, 10, 20].map((h) => <button key={h} type="button" aria-pressed={horizon === h} onClick={() => setHorizon(h)} style={{ color: horizon === h ? "#fff" : T.sub, background: horizon === h ? T.accent : "transparent", border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>{h} sessions</button>)}</div>
    </div>
    <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6 }}>Does an LLM add information beyond the deterministic score on the same symbols and outcomes? Each row has its own matched baseline. Different rows are not a model leaderboard. This broad research cohort mixes entry candidates, holdings and researched instrument types; it is not proof of entry-selection skill. The prompt forecasts ten sessions; other horizons test portability.</p>
    <nav aria-label="Prediction evidence sections" style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12 }}>{[["council-evidence", "Council & coverage"], ["formula-evidence", "Formulas & historical fits"], ["strategy-evidence", "Strategy governance"]].map(([id, label]) => <a key={id} href={`#${id}`} style={{ color: T.accent }}>{label}</a>)}<a href="/dashboard/strategies" style={{ color: T.accent }}>Strategy fit (not performance)</a><a href="/dashboard/research" style={{ color: T.accent }}>Symbol score history</a><a href="/dashboard/upgrade-path" style={{ color: T.accent }}>Upgrade Path & impact evidence</a></nav>
    {error && <p role="alert" style={{ color: "#F87171", fontSize: 12 }}>{error}</p>}
    {!data && !error && <p style={{ color: T.muted, fontSize: 12 }}>Reconstructing matched evidence from stored forecasts…</p>}
    {data && <>
      <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>Read at {new Date(data.asOf).toLocaleString()} · last 90 calendar days · {data.benchmark} · {data.labelVersion}<br />{data.coverage.runs} research runs · {data.coverage.forecasts} completed member forecasts · {data.coverage.labelledRuns} labelled runs · {data.coverage.unlabelled} without a complete matured price window · {data.coverage.missingAvailability} missing availability · {data.coverage.missingBaseline} missing baseline.</p>
      <div tabIndex={0} role="region" aria-label="Matched prediction comparisons" style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 850 }}>
        <thead><tr style={{ textAlign: "left", color: T.sub }}>{["Exact member / initial median", "Paired observations", "Dates / rough windows", "LLM IC", "Baseline IC", "IC lift", "Score rank correlation", "Descriptive HAC t", "State"].map((label) => <th key={label} style={{ padding: "8px 10px 8px 0", fontWeight: 500 }}>{label}</th>)}</tr></thead>
        <tbody>{data.cells.map((c) => <tr key={c.method} title={`Common sample: ${c.commonSampleHash}`} style={{ color: T.text, borderTop: `1px solid ${T.border}` }}>{[c.method, `${c.observations} / ${c.returnedPoints} returned points`, `${c.sessions} / ${c.roughWindows.toFixed(1)}`, num(c.ic), num(c.baselineIc), num(c.deltaIc), num(c.scoreRankCorrelation), num(c.descriptiveHacT), c.state === "insufficient_evidence" ? "Insufficient evidence" : "Descriptive only"].map((v, i) => <td key={i} style={{ padding: "10px 12px 10px 0", maxWidth: i === 0 ? 330 : undefined, overflowWrap: "anywhere" }}>{v}</td>)}</tr>)}</tbody>
      </table></div>
      {!data.cells.length && <p style={{ color: T.sub, fontSize: 12 }}>No comparable completed forecasts with valid availability and matured labels yet. No supported winner.</p>}
      <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.6 }}>{data.convention}<br />IC = score rank versus later excess return, not win probability. Score rank correlation measures similarity to the baseline, not proof of copying. Windows = dates ÷ horizon, not estimated effective sample size. t is withheld below 20 dates and 12 rough windows; even above those floors it is descriptive, not calibrated significance.<br />{data.caveat}</p>
    </>}
  </section>;
}
