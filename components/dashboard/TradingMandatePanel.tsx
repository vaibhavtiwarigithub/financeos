"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";
import { HORIZON_PRESETS, type ExistingPositionsPolicy, type HorizonGovernance, type HorizonStyle, type StrategyPreference, type TradingMandate } from "@/lib/trading-mandate";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171" };
const HORIZONS: Array<[HorizonStyle, string, string]> = [["short_swing", "Short swing", "2-5 market days"], ["swing", "Swing", "5-15 market days"], ["position", "Position", "10-20 market days"]];
const STRATEGIES: Array<[StrategyPreference, string, string]> = [["adaptive", "Adaptive", "Champion/default weights"], ["momentum", "Momentum", "Technical and sentiment tilt"], ["balanced", "Balanced", "No factor tilt"], ["value_quality", "Value / quality", "Fundamental and insider tilt"]];

function Choice<TValue extends string>({ item, selected, onSelect }: { item: [TValue, string, string]; selected: boolean; onSelect: (v: TValue) => void }) {
  return <button onClick={() => onSelect(item[0])} style={{ minWidth: 150, flex: 1, textAlign: "left", padding: "10px 12px", borderRadius: 8, border: `1px solid ${selected ? T.accent : T.border}`, background: selected ? "#1E1F3A" : T.surface, color: selected ? T.text : T.sub, cursor: "pointer" }}><div style={{ fontSize: 13, fontWeight: 700 }}>{item[1]}</div><div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>{item[2]}</div></button>;
}

export default function TradingMandatePanel() {
  const { market } = useMarket();
  const [mandates, setMandates] = useState<Record<string, TradingMandate>>({});
  const [draft, setDraft] = useState<TradingMandate | null>(null);
  const [degraded, setDegraded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { fetch("/api/settings/trading-mandate").then(r => r.json()).then(d => { const next: Record<string, TradingMandate> = {}; for (const m of d.mandates ?? []) next[m.market] = m; setMandates(next); setDegraded(!!d.degraded); }).catch(() => setMessage("Could not load Trading Mandates.")); }, []);
  useEffect(() => { setDraft(mandates[market] ? { ...mandates[market] } : null); setMessage(""); }, [market, mandates]);
  function selectHorizon(style: HorizonStyle) { if (draft) setDraft({ ...draft, horizon_style: style, ...HORIZON_PRESETS[style] }); }
  async function save() { if (!draft) return; setSaving(true); setMessage(""); try { const res = await fetch("/api/settings/trading-mandate", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) }); const data = await res.json(); if (!res.ok) throw new Error(data.error ?? "Save failed"); setMandates(prev => ({ ...prev, [market]: data.mandate })); setMessage(`${market.toUpperCase()} mandate v${data.mandate.version} saved.`); } catch (e) { setMessage(e instanceof Error ? e.message : "Save failed"); } finally { setSaving(false); } }
  if (!draft) return <div style={{ color: T.muted, fontSize: 13 }}>Loading Trading Mandate...</div>;
  const selectStyle = { width: "100%", marginTop: 6, padding: 9, borderRadius: 6, border: `1px solid ${T.border}`, background: T.surface, color: T.text };
  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "clamp(16px,4vw,24px)", marginBottom: 20 }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Trading Mandate: {market === "india" ? "India" : "US"}</div>
    <div style={{ fontSize: 12, color: T.sub, marginTop: 4, marginBottom: 18 }}>Controls new research and trades for this market. Risk profile still controls sizing and kill switches.</div>
    <div style={{ fontSize: 11, color: T.muted, marginBottom: 7 }}>Investment horizon</div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>{HORIZONS.map(x => <Choice key={x[0]} item={x} selected={draft.horizon_style === x[0]} onSelect={selectHorizon} />)}</div>
    <div style={{ fontSize: 11, color: T.muted, marginBottom: 7 }}>Strategy preference</div>
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>{STRATEGIES.map(x => <Choice key={x[0]} item={x} selected={draft.strategy_preference === x[0]} onSelect={v => setDraft({ ...draft, strategy_preference: v })} />)}</div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(210px,1fr))", gap: 12, marginBottom: 16 }}>
      <label style={{ color: T.sub, fontSize: 12 }}>Horizon authority<select value={draft.horizon_governance} onChange={e => setDraft({ ...draft, horizon_governance: e.target.value as HorizonGovernance })} style={selectStyle}><option value="user">User controlled</option><option value="agent">Agent may optimize within range</option></select></label>
      <label style={{ color: T.sub, fontSize: 12 }}>Open positions after changes<select value={draft.existing_positions_policy} onChange={e => setDraft({ ...draft, existing_positions_policy: e.target.value as ExistingPositionsPolicy })} style={selectStyle}><option value="grandfather">Keep entry-time mandate</option><option value="apply">Apply current mandate</option></select></label>
      <label style={{ color: T.sub, fontSize: 12 }}>Maximum open alpha positions<input type="number" min={1} max={50} step={1} value={draft.max_open_positions} onChange={e => setDraft({ ...draft, max_open_positions: Number(e.target.value) })} style={selectStyle} /></label>
      <label style={{ color: T.sub, fontSize: 12 }}>Score freshness (market sessions)<input type="number" min={0} max={10} step={1} value={draft.max_signal_age_sessions} onChange={e => setDraft({ ...draft, max_signal_age_sessions: Number(e.target.value) })} style={selectStyle} /></label>
    </div>
    <div style={{ fontSize: 12, color: T.sub, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: 10, marginBottom: 14 }}>Score {draft.score_threshold}+ | max {draft.max_open_positions} names | score age ≤{draft.max_signal_age_sessions} sessions | stop {draft.stop_loss_pct}% | target {draft.target_pct}% | target hold {draft.target_hold_days} market days | allowed {draft.min_hold_days}-{draft.max_hold_days}</div>
    {degraded && <div style={{ color: T.red, fontSize: 12, marginBottom: 10 }}>Migration 168 is required before this can be saved.</div>}
    {message && <div style={{ color: message.includes("saved") ? T.green : T.red, fontSize: 12, marginBottom: 10 }}>{message}</div>}
    <button onClick={save} disabled={saving || degraded} style={{ border: 0, borderRadius: 7, background: T.accent, color: "white", padding: "10px 18px", fontWeight: 700, cursor: "pointer", opacity: saving || degraded ? 0.6 : 1 }}>{saving ? "Saving..." : `Save ${market.toUpperCase()} mandate`}</button>
  </div>;
}
