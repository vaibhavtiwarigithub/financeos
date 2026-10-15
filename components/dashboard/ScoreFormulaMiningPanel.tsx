"use client";

import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Play, RefreshCw } from "lucide-react";
import { useMarket } from "@/lib/market-context";

type Fit = { sessions?: number; independentWindows?: number; coverageRows?: number; meanIc?: number | null; meanIcT?: number | null; spread?: number | null; spreadT?: number | null; pairedSpreadDelta?: number | null; pairedSpreadDeltaT?: number | null; baselineMeanIc?: number | null; baselineSpread?: number | null };
type Candidate = { variantId: string; label: string; weights: Record<string, number>; declaredAt: string; fit: Fit | null; fitCutoff: string | null; trialCount: number | null; totalRunTrials: number | null; caveat: string };
type Cell = { variant_id: string; sample: "forward" | "hindsight"; sessions: number; independent_windows: number; variant_mean_ic: number | null; variant_ic_t: number | null; variant_spread: number | null; variant_spread_t: number | null; paired_spread_delta: number | null; paired_spread_delta_t: number | null; baseline_mean_ic: number | null; baseline_spread: number | null; classification: string; reason: string };
type Payload = { error?: string; variantSet: string | null; evaluatedAt: string | null; candidates: Candidate[]; cells: Cell[] };

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171" };
const n = (v: number | null | undefined, d = 3) => v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);
const weights = (w: Record<string, number>) => Object.entries(w).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(" · ");
const date = (s: string | null | undefined) => s ? `${new Date(s).toISOString().slice(0, 16).replace("T", " ")} UTC` : "—";

export default function ScoreFormulaMiningPanel() {
  const { market } = useMarket();
  const [horizon, setHorizon] = useState(10);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(`/api/learning/score-formula-lab?market=${market}&horizon=${horizon}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Could not load formula lab (${res.status})`);
      setPayload(body);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load formula lab"); }
  }, [market, horizon]);

  useEffect(() => { void load(); }, [load]);

  const mine = async () => {
    setBusy(true); setError(""); setNotice("");
    try {
      const res = await fetch("/api/agents/score-formula-lab/mine", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `Historical fit failed (${res.status})`);
      setNotice(`Frozen ${body.candidateCount} candidate formulas in ${body.variantSet}. Forward evaluation begins at each formula's declaration time.`);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Historical fit failed"); }
    finally { setBusy(false); }
  };

  const cells = payload?.cells ?? [];
  const table = (sample: "hindsight" | "forward") => {
    const rows = (payload?.candidates ?? []).map((candidate) => ({ candidate, cell: cells.find((c) => c.variant_id === candidate.variantId && c.sample === sample) }));
    return <div style={{ marginTop: 14, overflowX: "auto" }}>
      <div style={{ color: sample === "hindsight" ? T.amber : T.green, fontWeight: 700, fontSize: 12, marginBottom: 6 }}>{sample === "hindsight" ? "HISTORICAL FIT / HINDSIGHT — selected on these outcomes; never validation" : "FORWARD SHADOW — only labels from after declaration count"}</div>
      {!rows.length ? <div style={{ color: T.muted, fontSize: 12, padding: "10px 0" }}>No mined formulas declared yet.</div> : <table style={{ width: "100%", minWidth: 800, borderCollapse: "collapse", fontSize: 11 }}>
        <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Candidate / weights", "Sessions / rough windows*", "Rank IC / HAC t", "Top-minus-bottom spread / HAC t", "Paired spread lift / HAC t", "Baseline IC / spread", "State"].map((x) => <th key={x} style={{ padding: "7px 10px 7px 0", fontWeight: 500 }}>{x}</th>)}</tr></thead>
        <tbody>{rows.map(({ candidate, cell }) => {
          const fit = sample === "hindsight" ? candidate.fit : null;
          return <tr key={candidate.variantId} title={cell?.reason ?? candidate.caveat} style={{ borderTop: `1px solid ${T.border}`, color: T.text, verticalAlign: "top" }}>
            <td style={{ padding: "8px 10px 8px 0" }}><strong>{candidate.label}</strong><div style={{ color: T.sub, marginTop: 3 }}>{weights(candidate.weights)}</div><div style={{ color: T.muted, marginTop: 3 }}>Declared {date(candidate.declaredAt)}</div></td>
            <td style={{ padding: "8px 10px 8px 0" }}>{sample === "hindsight" ? fit?.sessions ?? "—" : cell?.sessions ?? 0}<div style={{ color: T.sub }}>{sample === "hindsight" ? n(fit?.independentWindows, 2) : n(cell?.independent_windows, 2)} rough windows</div></td>
            <td style={{ padding: "8px 10px 8px 0" }}>{n(sample === "hindsight" ? fit?.meanIc : cell?.variant_mean_ic)} / {n(sample === "hindsight" ? fit?.meanIcT : cell?.variant_ic_t, 2)}</td>
            <td style={{ padding: "8px 10px 8px 0" }}>{n(sample === "hindsight" ? fit?.spread : cell?.variant_spread)} / {n(sample === "hindsight" ? fit?.spreadT : cell?.variant_spread_t, 2)}</td>
            <td style={{ padding: "8px 10px 8px 0" }}>{n(sample === "hindsight" ? fit?.pairedSpreadDelta : cell?.paired_spread_delta)} / {n(sample === "hindsight" ? fit?.pairedSpreadDeltaT : cell?.paired_spread_delta_t, 2)}</td>
            <td style={{ padding: "8px 10px 8px 0" }}>{sample === "hindsight" ? `${n(fit?.baselineMeanIc)} / ${n(fit?.baselineSpread)}` : `${n(cell?.baseline_mean_ic)} / ${n(cell?.baseline_spread)}`}</td>
            <td style={{ padding: "8px 10px 8px 0", color: sample === "forward" && cell?.classification !== "insufficient_evidence" ? T.amber : T.sub }}>{sample === "hindsight" ? `${candidate.trialCount ?? 0} formulas in this cell · ${candidate.totalRunTrials ?? "—"} total fits` : cell?.classification ?? "awaiting labels"}<div style={{ color: T.muted, maxWidth: 260 }}>{sample === "forward" ? cell?.reason : `Fit cutoff ${date(candidate.fitCutoff)}. Selected in-sample; this is intentionally overfit.`}</div></td>
          </tr>;
        })}</tbody>
      </table>}
    </div>;
  };

  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
      <div><div style={{ display: "flex", alignItems: "center", gap: 7, color: T.text, fontSize: 15, fontWeight: 700 }}><FlaskConical size={16} color={T.accent} /> Historical formula mining → forward test</div>
        <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, marginTop: 6, maxWidth: 900 }}>Searches a fixed 0.1-step weight grid across stored fundamental, technical, sentiment and insider dimensions, then freezes the historical winner and best leave-one-dimension-out variants. Fit and forward grades use the same complete-case eligible-long entry cohort, never held-name reviews. Macro is excluded because a market-wide macro value cannot rank names cross-sectionally. Nothing feeds live scores, orders, sizing or rotation.</div></div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{[2, 5, 10, 20].map((h) => <button key={h} onClick={() => setHorizon(h)} style={{ background: h === horizon ? T.accent : "transparent", color: h === horizon ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "5px 9px", cursor: "pointer", fontSize: 11 }}>h{h}</button>)}
        <button onClick={() => void load()} aria-label="Refresh formula lab" style={{ background: "transparent", color: T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: 6, cursor: "pointer" }}><RefreshCw size={14} /></button></div>
    </div>
    <div style={{ color: T.muted, fontSize: 11, marginTop: 10 }}>*Rough window count = sessions ÷ horizon; this is not a measured effective sample size. HAC t-statistics use a Bartlett Newey–West correction for overlapping labels. Even a positive forward IC does not establish portfolio-level outperformance; no variant is automatically promoted.</div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
      <div style={{ color: T.muted, fontSize: 11 }}>Market: {market.toUpperCase()} · labels: benchmark-neutral forward return · last shadow {date(payload?.evaluatedAt)} · candidate set {payload?.variantSet ?? "not mined"}</div>
      <button onClick={() => void mine()} disabled={busy || Boolean(payload?.variantSet)} style={{ display: "inline-flex", gap: 6, alignItems: "center", background: busy || payload?.variantSet ? "#252836" : T.accent, color: "#fff", border: 0, borderRadius: 6, padding: "7px 10px", cursor: busy || payload?.variantSet ? "not-allowed" : "pointer", fontSize: 11 }}><Play size={13} />{busy ? "Mining…" : payload?.variantSet ? "Historical fit frozen" : "Mine once & freeze candidates"}</button>
    </div>
    {notice && <div style={{ color: T.green, fontSize: 12, marginTop: 10 }}>{notice}</div>}
    {error && <div style={{ color: T.red, fontSize: 12, marginTop: 10 }}>{error}</div>}
    {!payload?.variantSet && <div style={{ color: T.amber, fontSize: 12, marginTop: 12, lineHeight: 1.5 }}>Exploratory only: current dimensional history starts in July 2026, not 2010. The fit is entry-eligible long candidates with every available dimension present; incomplete rows are excluded equally for all formulas. A one-time fit can reveal candidate weights, but multiple testing guarantees optimistic hindsight. The candidate search is frozen after one run; forward evidence starts only after declaration and needs months of new matured labels. The service endpoint is owner-only.</div>}
    {payload?.variantSet && <>{table("hindsight")}{table("forward")}</>}
  </section>;
}
