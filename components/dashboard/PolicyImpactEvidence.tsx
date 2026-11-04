"use client";

import { useEffect, useState } from "react";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", green: "#34D399", amber: "#FBBF24" };
type Outcome = { event_id: number; horizon_days: number; subject_symbol: string; fwd_return: number | null; benchmark_neutral_return: number | null; matched_control_n: number; matched_control_delta: number | null; forward_volatility: number | null; max_drawdown: number | null };
type Event = { id: number; event_type: string; occurred_at: string; market_policy_event_context: any; market_policy_event_exposures: any[]; policy_outcomes: Outcome[] };

export default function PolicyImpactEvidence() {
  const [events, setEvents] = useState<Event[]>([]);
  const [status, setStatus] = useState("Loading sourced US events…");
  useEffect(() => {
    let alive = true;
    fetch("/api/events?market=us").then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Event evidence unavailable");
      if (alive) {
        const policy = (body.events ?? []).filter((event: Event) => event.market_policy_event_context);
        setEvents(policy);
        setStatus(policy.length ? "" : "No sourced election or federal-policy events are recorded. No neutral assumption is made.");
      }
    }).catch((error) => alive && setStatus(error instanceof Error ? error.message : "Event evidence unavailable"));
    return () => { alive = false; };
  }, []);
  const eventCount = new Set(events.map((event) => event.id)).size;
  const matureEventHorizonCount = new Set(events.flatMap((event) => event.policy_outcomes.map((row) => `${event.id}|${row.horizon_days}`))).size;
  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 14, marginTop: 12 }}>
    <div style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>Election & federal-policy impact · US</div>
    <div style={{ color: T.sub, fontSize: 11, lineHeight: 1.5, marginTop: 5 }}>Descriptive event study from the existing stored return series. One election/policy event is one event observation; its exposed symbols are correlated rows, not independent replications. Matched controls use the 20 nearest prior non-event windows by SPY's preceding 20-session return and volatility. Windows may overlap, so their count is not an effective sample size; this is not a causal estimate.</div>
    <div style={{ color: T.muted, fontSize: 10, marginTop: 6 }}>Recorded events: {eventCount} · event/horizon cells with completed returns: {matureEventHorizonCount} · fixed horizons: 1, 5, 20, 60 sessions · benchmark: SPY</div>
    {status && <div style={{ color: T.muted, fontSize: 11, padding: "12px 0" }}>{status}</div>}
    {events.slice(0, 20).map((event) => {
      const rawContext = event.market_policy_event_context;
      const context = Array.isArray(rawContext) ? rawContext[0] : rawContext;
      const outcomes = event.policy_outcomes ?? [];
      return <div key={event.id} style={{ borderTop: `1px solid ${T.border}`, padding: "9px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: T.text, fontSize: 11 }}>{context?.event_title ?? event.event_type} · {context?.stage_status}</span>
          <span style={{ color: T.muted, fontSize: 10 }}>{new Date(event.occurred_at).toLocaleDateString()}</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
          {(context?.market_policy_event_exposures ?? []).map((exposure: any) => {
            const eventOutcomes = outcomes.filter((row) => row.subject_symbol === exposure.symbol);
            return <div key={exposure.symbol} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 8px", minWidth: 160 }}>
              <div style={{ color: T.text, fontSize: 10 }}>{exposure.symbol} · {exposure.exposure_stance}</div>
              <div style={{ color: T.muted, fontSize: 9, marginTop: 3 }}>{exposure.rationale}</div>
              <div style={{ color: T.sub, fontSize: 9, marginTop: 4 }}>{[1, 5, 20, 60].map((horizon) => {
                const row = eventOutcomes.find((item) => item.horizon_days === horizon);
                const value = row?.benchmark_neutral_return ?? row?.fwd_return;
                return <span key={horizon} style={{ color: value == null ? T.muted : Number(value) >= 0 ? T.green : T.amber, marginRight: 6 }}>{horizon}s {value == null ? "pending" : `${(Number(value) * 100).toFixed(1)}%${row?.benchmark_neutral_return == null ? " raw" : " rel"}`}{row?.matched_control_delta == null ? ` (ctl ${row?.matched_control_n ?? 0}/20)` : ` (vs ctl ${(Number(row.matched_control_delta) * 100).toFixed(1)}pp)`}{row && value != null ? ` · vol ${(Number(row.forward_volatility) * 100).toFixed(1)}% · DD ${(Number(row.max_drawdown) * 100).toFixed(1)}%` : ""}</span>;
              })}</div>
            </div>;
          })}
        </div>
        <div style={{ color: T.muted, fontSize: 9, marginTop: 5 }}>Exposure rows: {(context?.market_policy_event_exposures ?? []).length}; complete outcome rows: {outcomes.length}. Insufficient history remains pending; this is not a predictive score or trading instruction.</div>
      </div>;
    })}
  </div>;
}
