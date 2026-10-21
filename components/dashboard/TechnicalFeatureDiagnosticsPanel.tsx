"use client";
import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", bg: "#13151C" };
type Cell = { feature: string; binary: boolean; formula: string; observations: number; availablePoints: number; qualifyingDates: number; mode: string; rankIc: number | null; descriptiveT: number | null; triggered: number; control: number; contrast: number | null; state: string };
type Data = { matchedPoints: number; excludedRows: number; predeclaredFeatures: number; currentFormulaVersions: Record<string, string>; caveat: string; cells: Cell[] };
const num = (v: number | null) => v == null ? "—" : v.toFixed(3);

export default function TechnicalFeatureDiagnosticsPanel({ horizon }: { horizon: number }) {
  const { market } = useMarket();
  const [symbol, setSymbol] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const [cohort, setCohort] = useState("entry");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError("");
    if (query == null) return () => controller.abort();
    fetch(`/api/learning/prediction-lab?view=features&market=${market}&horizon=${horizon}&cohort=${cohort}&symbol=${encodeURIComponent(query)}`, { cache: "no-store", signal: controller.signal })
      .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error ?? "Feature diagnostics unavailable"); return b; })
      .then(setData).catch((e) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [market, horizon, cohort, query, request]);
  return <section aria-label="Technical feature diagnostics" style={{ marginTop: 18, paddingTop: 16, borderTop: `1px solid ${T.border}`, color: T.text }}>
    <h3 style={{ margin: 0, fontSize: 15 }}>RSI & MACD · feature and rule diagnostics</h3>
    <p style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>Nine fixed tests, not a search for whichever settings won. Blank symbol = cross-sectional IC; enter one symbol for non-overlapping time-series analysis. Formula versions and entry/holding cohorts stay separate. A raw RSI or MACD correlation is not the performance of the complete trading rule.</p>
    <form onSubmit={(e) => { e.preventDefault(); setQuery(symbol.trim().toUpperCase()); setRequest((n) => n + 1); }} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
      <label style={{ fontSize: 12 }}>Symbol (optional) <input aria-label="Feature diagnostic symbol" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={market === "us" ? "e.g. NVDA" : "e.g. INFY.NS"} maxLength={24} style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, padding: 8, borderRadius: 5, width: 140 }} /></label>
      <label style={{ fontSize: 12 }}>Cohort <select aria-label="Feature diagnostic cohort" value={cohort} onChange={(e) => setCohort(e.target.value)} style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, padding: 8, borderRadius: 5 }}><option value="entry">Eligible long entries</option><option value="holding">Holding reviews</option></select></label>
      <button type="submit" style={{ background: T.accent, color: "white", border: 0, padding: "9px 12px", borderRadius: 5, cursor: "pointer" }}>Evaluate stored data</button>
    </form>
    {error && <p role="alert" style={{ color: "#F87171", fontSize: 12 }}>{error}</p>}
    {query != null && !data && !error && <p style={{ color: T.muted, fontSize: 12 }}>Reading complete stored labels and validated source sessions…</p>}
    {data && <>
      <p style={{ color: T.sub, fontSize: 11, overflowWrap: "anywhere", lineHeight: 1.6 }}>Current definitions: {Object.entries(data.currentFormulaVersions).map(([dim, v]) => `${dim}: ${v}`).join(" · ")}. These names apply to new observations only; the measured rows below retain their recorded identity.</p>
      <p style={{ color: T.sub, fontSize: 11 }}>{data.matchedPoints} matched source rows · {data.excludedRows} excluded · {data.predeclaredFeatures} predeclared features · h{horizon}. Single-symbol t is withheld, not inferred from an IID correlation formula.</p>
      <div role="region" aria-label="Technical feature results" tabIndex={0} style={{ overflowX: "auto" }}><table style={{ width: "100%", minWidth: 820, borderCollapse: "collapse", fontSize: 11 }}>
        <thead><tr style={{ textAlign: "left", color: T.sub }}>{["Feature / state", "Technical formula", "Sample / available", "Dates", "Rank IC", "Descriptive t", "Triggered / control", "Return contrast", "State"].map((s) => <th key={s} style={{ padding: "8px 10px 8px 0" }}>{s}</th>)}</tr></thead>
        <tbody>{data.cells.map((c) => <tr key={`${c.formula}:${c.feature}`} style={{ borderTop: `1px solid ${T.border}` }}>{[c.feature, c.formula, `${c.observations} / ${c.availablePoints}`, c.qualifyingDates, num(c.rankIc), num(c.descriptiveT), c.binary ? `${c.triggered} / ${c.control}` : "—", c.contrast == null ? "—" : `${(c.contrast * 100).toFixed(2)} pp`, c.state.replaceAll("_", " ")].map((v, i) => <td key={i} style={{ padding: "10px 10px 10px 0", overflowWrap: "anywhere" }}>{v}</td>)}</tr>)}</tbody>
      </table></div>
      {!data.cells.length && <p style={{ fontSize: 12, color: T.sub }}>No matched, session-validated observations for this selection. Missing evidence is not a losing or winning rule.</p>}
      <p style={{ fontSize: 11, lineHeight: 1.6, color: T.muted }}>{data.caveat}</p>
    </>}
  </section>;
}
