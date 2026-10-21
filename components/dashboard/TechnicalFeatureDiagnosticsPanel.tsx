"use client";
import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", bg: "#13151C" };
type Cell = { feature: string; binary: boolean; formula: string; family: string; observations: number; availablePoints: number; qualifyingDates: number; mode: string; rankIc: number | null; descriptiveT: number | null; triggered: number; control: number; contrast: number | null; state: string };
type PairedCell = { method: string; observations: number; sessions: number; roughWindows: number; ic: number | null; baselineIc: number | null; deltaIc: number | null; descriptiveHacT: number | null; state: string };
type Data = { matchedPoints: number; excludedRows: number; predeclaredFeatures: number; currentFormulaVersions: Record<string, string>; caveat: string; cells: Cell[]; dimensionCells: Cell[]; pairedMacd: PairedCell[] };
const num = (v: number | null) => v == null ? "—" : v.toFixed(3);

export default function TechnicalFeatureDiagnosticsPanel({ horizon }: { horizon: number }) {
  const { market } = useMarket();
  const [symbol, setSymbol] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [cohort, setCohort] = useState("entry");
  const [series, setSeries] = useState("dimensions");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    if (query == null) return () => controller.abort();
    fetch(`/api/learning/prediction-lab?view=features&market=${market}&horizon=${horizon}&cohort=${cohort}&symbol=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal })
      .then(async (r) => {
        const b = await r.json().catch(() => null);
        if (!r.ok) throw new Error(typeof b?.error === "string" ? b.error : `Feature diagnostics unavailable (HTTP ${r.status}). Use Evaluate stored data to retry.`);
        if (!b || !Array.isArray(b.cells) || !b.currentFormulaVersions) throw new Error("Feature diagnostics returned an incomplete response. Use Evaluate stored data to retry.");
        return b;
      })
      .then((body) => { if (!controller.signal.aborted) setData(body); }).catch((e) => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Feature diagnostics unavailable. Please retry."); });
    return () => controller.abort();
  }, [market, horizon, cohort, query, request]);
  return <section aria-label="Technical feature diagnostics" style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${T.border}`, color: T.text }}>
    <h3 style={{ margin: 0, fontSize: 15 }}>Dimension formulas, RSI & MACD diagnostics</h3>
    <p style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>Recorded dimension/composite scores plus nine fixed indicator tests, not a search for whichever settings won. Blank symbol = cross-sectional IC; enter one symbol for non-overlapping time-series analysis. Formula versions, instrument families and entry/holding cohorts stay separate. These rows are not a paired winner leaderboard or strategy P&L.</p>
    <form onSubmit={(e) => { e.preventDefault(); setQuery(symbol.trim().toUpperCase()); setRequest((n) => n + 1); }} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <label style={{ fontSize: 12 }}>Symbol (optional) <input aria-label="Feature diagnostic symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={market === "us" ? "e.g. NVDA" : "e.g. INFY.NS"} maxLength={24} style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, padding: 8, borderRadius: 5, width: 140 }} /></label>
      <label style={{ fontSize: 12 }}>Cohort <select aria-label="Feature diagnostic cohort" value={cohort} onChange={(e) => setCohort(e.target.value)} style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, padding: 8, borderRadius: 5 }}><option value="entry">Eligible long entries</option><option value="holding">Holding reviews</option></select></label>
      <label style={{ fontSize: 12 }}>Show <select aria-label="Diagnostic series" value={series} onChange={(e) => setSeries(e.target.value)} style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, padding: 8, borderRadius: 5 }}><option value="dimensions">Dimensions & composite</option><option value="features">RSI / MACD rules</option><option value="paired">Technical vs frozen v1 · paired</option></select></label>
      <button type="submit" style={{ background: T.accent, color: "white", border: 0, padding: "9px 12px", borderRadius: 5, cursor: "pointer" }}>Evaluate stored data</button>
    </form>
    {error && <p role="alert" style={{ color: "#F87171", fontSize: 12 }}>{error}</p>}
    {query != null && !data && !error && <p style={{ color: T.muted, fontSize: 12 }}>Reading complete stored labels and validated source sessions…</p>}
    {data && <>
      <details style={{ color: T.sub, fontSize: 12, marginTop: 12 }}><summary style={{ cursor: "pointer" }}>Current formula versions & indicator definitions</summary><p style={{ fontSize: 11, overflowWrap: "anywhere", lineHeight: 1.6 }}>Current definitions: {Object.entries(data.currentFormulaVersions).map(([dim, v]) => `${dim}: ${v}`).join(" · ")}. These names apply to new observations only; the measured rows below retain their recorded identity. RSI = Relative Strength Index. MACD = Moving Average Convergence Divergence. ATR = Average True Range.</p></details>
      <p style={{ color: T.sub, fontSize: 11 }}>{data.matchedPoints} matched source rows · {data.excludedRows} excluded · {data.predeclaredFeatures} predeclared features · h{horizon}. Single-symbol t is withheld, not inferred from an IID correlation formula.</p>
      {series === "paired" && <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6 }}>Current and frozen-v1 technical scores must have been recorded together and match the stored score trace. Both use identical symbols and outcomes, with at least 15 names per session and instrument family. This measures score-rank lift, not portfolio P&L. A single selected symbol cannot have this cross-sectional comparison.</p>}
      <div role="region" aria-label="Technical feature results" tabIndex={0} style={{ overflow: "auto", maxHeight: 440 }}><table style={{ width: "100%", minWidth: 1050, borderCollapse: "collapse", fontSize: 11 }}>
        {series === "paired" ? <>
          <thead style={{ position: "sticky", top: 0, background: T.bg, zIndex: 1 }}><tr style={{ textAlign: "left", color: T.sub }}>{["Paired technical methods", "Observations", "Dates / rough windows", "Current IC", "Frozen v1 IC", "Paired IC lift", "Descriptive t", "State"].map((s) => <th key={s} scope="col" style={{ padding: "8px 10px 8px 0" }}>{s}</th>)}</tr></thead>
          <tbody>{(data.pairedMacd ?? []).map((c) => <tr key={c.method} style={{ borderTop: `1px solid ${T.border}` }}>{[c.method, c.observations, `${c.sessions} / ${c.roughWindows.toFixed(1)}`, num(c.ic), num(c.baselineIc), num(c.deltaIc), num(c.descriptiveHacT), c.state.replaceAll("_", " ")].map((v, i) => <td key={i} style={{ padding: "10px 10px 10px 0", overflowWrap: "anywhere" }}>{v}</td>)}</tr>)}</tbody>
        </> : <>
        <thead style={{ position: "sticky", top: 0, background: T.bg, zIndex: 1 }}><tr style={{ textAlign: "left", color: T.sub }}>{["Score / indicator", "Recorded formula", "Instrument family", "Sample / available", "Dates", "Rank IC", "Descriptive t", "Triggered / control", "Return contrast", "State"].map((s) => <th key={s} scope="col" style={{ padding: "8px 10px 8px 0" }}>{s}</th>)}</tr></thead>
        <tbody>{(series === "dimensions" ? data.dimensionCells ?? [] : data.cells).map((c) => <tr key={`${c.family}:${c.formula}:${c.feature}`} style={{ borderTop: `1px solid ${T.border}` }}>{[c.feature.replaceAll("_", " "), c.formula, c.family.replaceAll("_", " "), `${c.observations} / ${c.availablePoints}`, c.qualifyingDates, num(c.rankIc), num(c.descriptiveT), c.binary ? `${c.triggered} / ${c.control}` : "—", c.contrast == null ? "—" : `${(c.contrast * 100).toFixed(2)} pp`, c.state.replaceAll("_", " ")].map((v, i) => <td key={i} style={{ padding: "10px 10px 10px 0", overflowWrap: "anywhere" }}>{v}</td>)}</tr>)}</tbody>
        </>}
      </table></div>
      {series === "paired" && !(data.pairedMacd ?? []).length && <p style={{ fontSize: 12, color: T.sub }}>No matured, comparable current/v1 score pairs for this selection yet. New score traces must first acquire future labels; historical missing v1 scores are not reconstructed.</p>}
      {!data.cells.length && <p style={{ fontSize: 12, color: T.sub }}>No matched, session-validated observations for this selection. Missing evidence is not a losing or winning rule.</p>}
      <p style={{ fontSize: 11, lineHeight: 1.6, color: T.muted }}>t is descriptive only: a normal threshold such as |t| &gt; 1.96 is not a validated significance or adoption test here. {data.caveat}</p>
    </>}
  </section>;
}
