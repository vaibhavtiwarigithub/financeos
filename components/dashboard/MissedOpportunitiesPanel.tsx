"use client";
import { useEffect, useMemo, useState } from "react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { fmtMoney, type Mkt } from "@/lib/format-money";

const T = { surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#9B9EA8", faint: "#6B7280", accent: "#818CF8", green: "#34D399", red: "#F87171", amber: "#FBBF24" };
type Episode = { id: string; symbol: string; decision_at: string; entry_score: number; reference_price: number; hypothetical_fill_price: number; hypothetical_notional: number | null; block_reason: string; stop_loss: number | null; price_target: number | null; horizon_sessions: number; subsequentlyBoughtAt: string | null; marks: { points: { date: string; missedReturnPct: number; benchmarkReturnPct: number | null }[]; benchmarkSymbol: string; missedPnl: number | null; missedReturnPct: number | null; excessReturnPct: number | null; riskManagedPnl: number | null; riskManagedReturnPct: number | null; riskManagedExitSession: string | null; riskManagedExitReason: string | null; matchedSessions: number; observedSessions: number; horizonSessions: number; matured: boolean; status: string; closeStopSession: string | null; closeTargetSession: string | null } };
export default function MissedOpportunitiesPanel({ market }: { market: Mkt }) {
  const [episodes, setEpisodes] = useState<Episode[]>([]), [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setEpisodes([]); setSelectedId(null);
    fetch(`/api/agents/missed-paper-opportunities?market=${market}`, { cache: "no-store" })
      .then(async res => { const body = await res.json(); if (!res.ok) throw new Error(body.error ?? "Could not load missed-entry evidence"); return body; })
      .then(body => { if (active) { setEpisodes(body.episodes ?? []); setSelectedId(body.episodes?.[0]?.id ?? null); } })
      .catch(e => { if (active) setError(e instanceof Error ? e.message : "Could not load missed-entry evidence"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [market]);
  const selected = useMemo(() => episodes.find(row => row.id === selectedId) ?? null, [episodes, selectedId]);
  const panel: React.CSSProperties = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 };
  const signed = (n: number | null) => n == null ? "—" : `${n >= 0 ? "+" : "−"}${fmtMoney(Math.abs(n), market, 0)}`;
  return <section style={{ ...panel, marginBottom: 18 }}>
    <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Qualified entries blocked by portfolio constraints</div>
    <p style={{ color: T.muted, fontSize: 12, lineHeight: 1.55, maxWidth: 900 }}>
      Frozen, entry-qualified long signals the paper trader could not place because of cash, portfolio capacity, minimum order size, a daily limit, or a rotation refusal. Later close-based marks are counterfactual estimates, not profit Kairos actually earned. A later real buy of the symbol censors that episode.
    </p>
    {loading ? <div style={{ color: T.muted, padding: 24 }}>Loading decision and price evidence…</div>
      : error ? <div role="alert" style={{ color: T.red, padding: 12 }}>{error}</div>
      : episodes.length === 0 ? <div style={{ color: T.muted, padding: 18 }}>No qualifying capacity-blocked entries recorded yet. New evidence starts when the paper trader encounters one.</div>
      : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, margin: "14px 0" }}>
          <div style={panel}><div style={{ color: T.faint, fontSize: 11 }}>Recorded attempts</div><strong>{episodes.length}</strong></div>
          <div style={panel}><div style={{ color: T.faint, fontSize: 11 }}>Matured to planned horizon</div><strong>{episodes.filter(row => row.marks.matured).length}</strong></div>
          <div style={panel}><div style={{ color: T.faint, fontSize: 11 }}>With benchmark comparison</div><strong>{episodes.filter(row => row.marks.excessReturnPct != null).length}</strong></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,280px),1fr))", gap: 14 }}>
          <div style={{ maxHeight: 370, overflowY: "auto", display: "grid", gap: 7 }}>
            {episodes.map(row => <button key={row.id} onClick={() => setSelectedId(row.id)} style={{ textAlign: "left", background: selectedId === row.id ? "#242840" : T.surface, border: `1px solid ${selectedId === row.id ? T.accent : T.border}`, borderRadius: 8, padding: 10, color: T.text, cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 700 }}><span>{row.symbol} · {row.entry_score}</span><span style={{ color: row.marks.missedReturnPct == null ? T.faint : row.marks.missedReturnPct >= 0 ? T.green : T.red }}>{row.marks.missedReturnPct == null ? "No mark" : `${row.marks.missedReturnPct >= 0 ? "+" : ""}${row.marks.missedReturnPct.toFixed(2)}%`}</span></div>
              <div style={{ color: T.faint, fontSize: 10, marginTop: 4 }}>{new Date(row.decision_at).toLocaleString()} · {row.block_reason}</div>
            </button>)}
          </div>
          {selected && <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px 18px", color: T.muted, fontSize: 11, marginBottom: 8 }}>
              <span>Decision quote {fmtMoney(Number(selected.reference_price), market)}</span><span>Paper fill proxy {fmtMoney(Number(selected.hypothetical_fill_price), market)}</span>
              <span>Feasible notional {selected.hypothetical_notional == null ? "unavailable" : fmtMoney(selected.hypothetical_notional, market, 0)}</span>
              <span>Block: {selected.block_reason}</span>
            </div>
            <div style={{ width: "100%", height: 230 }}>
              {selected.marks.points.length > 1 ? <ResponsiveContainer>
                <LineChart data={selected.marks.points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false}/><XAxis dataKey="date" tick={{ fill: T.faint, fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd"/><YAxis tick={{ fill: T.faint, fontSize: 10 }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} width={42}/>
                  <Tooltip contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text }} formatter={(v: any, name: any) => [typeof v === "number" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "No matched mark", name]}/>
                  <Line dataKey="missedReturnPct" name={`${selected.symbol} close proxy`} stroke={T.accent} strokeWidth={2} dot={false} connectNulls={false}/>
                  <Line dataKey="benchmarkReturnPct" name={`${selected.marks.benchmarkSymbol} (matched dates)`} stroke={T.muted} strokeWidth={1.5} dot={false} connectNulls={false}/>
                </LineChart>
              </ResponsiveContainer> : <div style={{ height: "100%", display: "grid", placeItems: "center", color: T.faint, fontSize: 12 }}>No eligible post-decision daily close marks yet.</div>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12, margin: "4px 0 10px" }}>
              <span>Unmanaged horizon P&amp;L <b style={{ color: selected.marks.missedPnl == null ? T.faint : selected.marks.missedPnl >= 0 ? T.green : T.red }}>{signed(selected.marks.missedPnl)}</b></span>
              <span>Stop/target close-proxy P&amp;L <b style={{ color: selected.marks.riskManagedPnl == null ? T.faint : selected.marks.riskManagedPnl >= 0 ? T.green : T.red }}>{signed(selected.marks.riskManagedPnl)}</b></span>
              <span>Excess vs benchmark proxy <b style={{ color: selected.marks.excessReturnPct == null ? T.faint : selected.marks.excessReturnPct >= 0 ? T.green : T.red }}>{selected.marks.excessReturnPct == null ? "unavailable" : `${selected.marks.excessReturnPct >= 0 ? "+" : ""}${selected.marks.excessReturnPct.toFixed(2)}%`}</b></span>
              <span>Sessions {selected.marks.observedSessions}/{selected.marks.horizonSessions} · matched {selected.marks.matchedSessions}</span>
            </div>
            <div style={{ color: T.faint, fontSize: 10, lineHeight: 1.5 }}>
              {selected.marks.status}. The chart marks closes from the frozen paper-fill proxy; benchmark marks use matched dates from the registered benchmark and the prior completed session as baseline, not a synchronized decision-time benchmark quote. Treat excess as a baseline proxy, not exact matched-entry alpha. Unmanaged horizon P&amp;L does not execute stops or targets. Stop/target close-proxy P&amp;L assumes exit at the first daily close beyond a frozen level, or at the horizon close if neither is reached; it is not an intraday touch, actual fill, slippage model, or realized return. Daily data cannot establish whether both barriers were touched intraday or in which order. Close-proxy exit: {selected.marks.riskManagedExitReason ?? "not yet available"} {selected.marks.riskManagedExitSession ?? ""}. Stop {selected.stop_loss == null ? "—" : fmtMoney(Number(selected.stop_loss), market)} · target {selected.price_target == null ? "—" : fmtMoney(Number(selected.price_target), market)}.
            </div>
          </div>}
        </div>
        <div style={{ color: T.faint, fontSize: 10, marginTop: 12 }}>Outcomes describe past blockers. They do not change eligibility, sizing, scores, exit levels, or trades automatically.</div>
      </>}
  </section>;
}
