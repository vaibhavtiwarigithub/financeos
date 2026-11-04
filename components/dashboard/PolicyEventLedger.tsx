"use client";

import { useCallback, useEffect, useState } from "react";
import { CHAMBERS, CONTROL_STATES, ELECTION_STAGES, EXPOSURE_STANCES, POLICY_DOMAINS, POLICY_STAGES } from "@/lib/events/policy-constants";

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#818CF8", green: "#34D399", amber: "#FBBF24",
};

type Impact = { symbol: string; excess_return_pct: number | null; symbol_return_pct: number; benchmark_return_pct: number | null };
type Item = {
  id: string; scheduled_date: string; status: "scheduled" | "decided";
  actual_effective_date: string | null; actual_target_lower: number | null; actual_target_upper: number | null;
  surprise_bps: number | null; official_source_url: string;
  expectation: { expected_target_lower: number; expected_target_upper: number; source_name: string; source_url: string; captured_at: string } | null;
  impact_summary: { horizon_sessions: number; observed_symbols: number; largest_excess: Impact[] }[];
};
type MarketEvent = {
  id: string; event_type: string; occurred_at: string; observed_at: string;
  market: "us" | "india" | "global"; direction: "escalation" | "de_escalation" | "neutral";
  magnitude: number | null; source_url: string; source_name: string; notes: string | null;
  market_policy_event_context?: any;
  policy_outcomes?: any[];
};

type ExposureDraft = { symbol: string; exposure_stance: string; rationale: string; source_name: string; source_url: string; source_published_at: string };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, color: T.text, borderRadius: 6, padding: "8px 9px", fontSize: 12 };

function range(lower: number | null, upper: number | null) {
  return lower == null || upper == null ? "Not published" : `${lower.toFixed(2)}%–${upper.toFixed(2)}%`;
}

export default function PolicyEventLedger({ market = "us" }: { market?: "us" | "india" }) {
  const [items, setItems] = useState<Item[]>([]);
  const [events, setEvents] = useState<MarketEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [eventType, setEventType] = useState<"election_control_change" | "federal_policy_action">("election_control_change");
  const [draft, setDraft] = useState({ title: "", occurred_at: "", source_name: "", source_url: "", source_evidence: "", notes: "", stage_status: "certified", chamber: "house", previous_control: "unknown", resulting_control: "unknown", policy_domain: "trade", policy_chain_id: "" });
  const [exposures, setExposures] = useState<ExposureDraft[]>([{ symbol: "", exposure_stance: "unknown", rationale: "", source_name: "", source_url: "", source_published_at: "" }]);

  const loadLedger = useCallback(async () => {
    const requests: Promise<Response>[] = [fetch(`/api/events?market=${market}`)];
    if (market === "us") requests.push(fetch("/api/markets/policy-events"));
    const responses = await Promise.all(requests);
    const payloads = await Promise.all(responses.map(async (response) => ({ ok: response.ok, body: await response.json() })));
    const [eventPayload, fomcPayload] = payloads;
    if (!eventPayload.ok) throw new Error(eventPayload.body?.error ?? "market-event ledger unavailable");
    if (fomcPayload && !fomcPayload.ok) throw new Error(fomcPayload.body?.error ?? "FOMC ledger unavailable");
    setEvents((eventPayload.body.events ?? []).filter((event: MarketEvent) => event.event_type.startsWith("policy_tariff_") || event.event_type === "election_control_change" || event.event_type === "federal_policy_action"));
    setItems(fomcPayload?.body?.items ?? []);
  }, [market]);

  useEffect(() => {
    let active = true;
    loadLedger()
      .then(() => { if (!active) return; })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : "policy-event ledger unavailable"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [market, loadLedger]);

  const upcoming = items.filter((item) => item.status === "scheduled").sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0];
  const latest = items.filter((item) => item.status === "decided").sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0];
  const latestTariffs = events.filter((event) => event.event_type.startsWith("policy_tariff_")).slice(0, 4);
  const newestTariffAgeDays = latestTariffs[0]
    ? Math.floor((Date.now() - Date.parse(latestTariffs[0].occurred_at)) / 86_400_000)
    : null;

  async function savePolicyEvent() {
    setSaving(true); setSaveMessage("");
    const isElection = eventType === "election_control_change";
    const context = {
      family: isElection ? "election" : "federal_policy",
      stage_status: draft.stage_status,
      policy_domain: isElection ? null : draft.policy_domain,
      chamber: isElection ? draft.chamber : null,
      previous_control: isElection ? draft.previous_control : null,
      resulting_control: isElection ? draft.resulting_control : null,
      event_title: draft.title,
      source_evidence: draft.source_evidence,
      ...(draft.policy_chain_id.trim() ? { policy_chain_id: draft.policy_chain_id.trim() } : {}),
    };
    const cleanExposures = exposures.filter((row) => row.symbol.trim()).map((row) => ({ ...row, source_published_at: new Date(row.source_published_at).toISOString() }));
    try {
      if (!draft.occurred_at) throw new Error("Enter when the event became public.");
      const response = await fetch("/api/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        event_type: eventType, market: "us", occurred_at: new Date(draft.occurred_at).toISOString(), direction: "neutral",
        source_url: draft.source_url, source_name: draft.source_name, notes: draft.notes || draft.source_evidence, context, exposures: cleanExposures,
      }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Event could not be saved.");
      const contextId = body.policy_chain_id ?? context.policy_chain_id ?? "(new chain ID is shown in the saved event)";
      setSaveMessage(`Saved. Policy-chain reference: ${contextId}`);
      setDraft((value) => ({ ...value, title: "", occurred_at: "", notes: "", source_url: "", source_evidence: "", policy_chain_id: body.policy_chain_id ?? value.policy_chain_id }));
      await loadLedger();
    } catch (cause) { setSaveMessage(cause instanceof Error ? cause.message : "Event could not be saved."); }
    finally { setSaving(false); }
  }

  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "14px" }}>
      <div>
        <div style={{ fontSize: "11px", color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "4px" }}>Policy & Tariff Evidence · {market.toUpperCase()}</div>
        <div style={{ fontSize: "12px", color: T.textSub }}>Cited, point-in-time events. Observation only; never a direct score or trade instruction.</div>
      </div>
      <span style={{ fontSize: "10px", color: T.amber, border: `1px solid ${T.amber}55`, borderRadius: "999px", padding: "3px 8px" }}>Manual, owner-reviewed ingest</span>
    </div>
    {loading && <div style={{ height: "62px", background: T.surface, borderRadius: "8px", animation: "pulse 1.5s ease-in-out infinite" }} />}
    {!loading && error && <div style={{ color: T.muted, fontSize: "12px" }}>Ledger unavailable: {error}</div>}
    {!loading && !error && !items.length && !events.length && <div style={{ color: T.muted, fontSize: "12px" }}>No cited policy events are recorded for this market. Absence is not a calm-policy signal.</div>}
    {market === "us" && <section style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 9, padding: 12, marginBottom: 14 }}>
      <div style={{ color: T.text, fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Record a sourced election or federal-policy event</div>
      <div style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, marginBottom: 10 }}>Use an official result or a cited policy record. Each lifecycle stage is a separate event; reuse the policy-chain ID shown on a saved event to connect later stages. This does not create a buy/sell signal.</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 8 }}>
        <select value={eventType} onChange={(e) => { setEventType(e.target.value as typeof eventType); setDraft((v) => ({ ...v, stage_status: e.target.value === "election_control_change" ? "certified" : "proposed" })); }} style={inputStyle}><option value="election_control_change">Election / chamber control</option><option value="federal_policy_action">Federal policy action</option></select>
        <input aria-label="Event title" placeholder="Event title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} style={inputStyle} />
        <input aria-label="Public event time" type="datetime-local" value={draft.occurred_at} onChange={(e) => setDraft({ ...draft, occurred_at: e.target.value })} style={inputStyle} />
        {eventType === "election_control_change" ? <>
          <select value={draft.stage_status} onChange={(e) => setDraft({ ...draft, stage_status: e.target.value })} style={inputStyle}>{ELECTION_STAGES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <select value={draft.chamber} onChange={(e) => setDraft({ ...draft, chamber: e.target.value })} style={inputStyle}>{CHAMBERS.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <select value={draft.previous_control} onChange={(e) => setDraft({ ...draft, previous_control: e.target.value })} style={inputStyle}>{CONTROL_STATES.map((v) => <option key={v} value={v}>Prior: {v}</option>)}</select>
          <select value={draft.resulting_control} onChange={(e) => setDraft({ ...draft, resulting_control: e.target.value })} style={inputStyle}>{CONTROL_STATES.map((v) => <option key={v} value={v}>Result: {v}</option>)}</select>
        </> : <>
          <select value={draft.stage_status} onChange={(e) => setDraft({ ...draft, stage_status: e.target.value })} style={inputStyle}>{POLICY_STAGES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
          <select value={draft.policy_domain} onChange={(e) => setDraft({ ...draft, policy_domain: e.target.value })} style={inputStyle}>{POLICY_DOMAINS.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        </>}
        <input aria-label="Policy chain ID" placeholder="Policy-chain ID to link later stage (optional)" value={draft.policy_chain_id} onChange={(e) => setDraft({ ...draft, policy_chain_id: e.target.value })} style={inputStyle} />
        <input aria-label="Primary source name" placeholder="Primary source name" value={draft.source_name} onChange={(e) => setDraft({ ...draft, source_name: e.target.value })} style={inputStyle} />
        <input aria-label="Primary source URL" placeholder="Official source URL" value={draft.source_url} onChange={(e) => setDraft({ ...draft, source_url: e.target.value })} style={inputStyle} />
        <textarea aria-label="Source evidence" placeholder="Short factual excerpt or paraphrase from the source (stored immutably)" value={draft.source_evidence} onChange={(e) => setDraft({ ...draft, source_evidence: e.target.value })} style={{ ...inputStyle, minHeight: 58, resize: "vertical" }} />
        <input aria-label="Notes" placeholder="Notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} style={inputStyle} />
      </div>
      <div style={{ marginTop: 10, color: T.textSub, fontSize: 11 }}>Symbol exposure evidence (must have been public by the event timestamp)</div>
      {exposures.map((row, index) => <div key={index} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 6, marginTop: 6 }}>
        <input aria-label={`Exposure symbol ${index + 1}`} placeholder="Symbol" value={row.symbol} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, symbol: e.target.value.toUpperCase() } : x))} style={inputStyle} />
        <select aria-label={`Exposure stance ${index + 1}`} value={row.exposure_stance} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, exposure_stance: e.target.value } : x))} style={inputStyle}>{EXPOSURE_STANCES.map((v) => <option key={v} value={v}>{v}</option>)}</select>
        <input aria-label={`Exposure rationale ${index + 1}`} placeholder="Why is it exposed?" value={row.rationale} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, rationale: e.target.value } : x))} style={inputStyle} />
        <input aria-label={`Exposure source ${index + 1}`} placeholder="Source name" value={row.source_name} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, source_name: e.target.value } : x))} style={inputStyle} />
        <input aria-label={`Exposure URL ${index + 1}`} placeholder="Source URL" value={row.source_url} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, source_url: e.target.value } : x))} style={inputStyle} />
        <input aria-label={`Exposure source publication time ${index + 1}`} type="datetime-local" value={row.source_published_at} onChange={(e) => setExposures((xs) => xs.map((x, i) => i === index ? { ...x, source_published_at: e.target.value } : x))} style={inputStyle} />
        <button type="button" onClick={() => setExposures((xs) => xs.length <= 1 ? xs : xs.filter((_, i) => i !== index))} style={{ ...inputStyle, width: "auto" }}>Remove</button>
      </div>)}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <button type="button" onClick={() => setExposures((xs) => xs.length >= 50 ? xs : [...xs, { symbol: "", exposure_stance: "unknown", rationale: "", source_name: "", source_url: "", source_published_at: "" }])} style={{ ...inputStyle, width: "auto" }}>Add symbol exposure</button>
        <button type="button" disabled={saving} onClick={savePolicyEvent} style={{ ...inputStyle, width: "auto", borderColor: T.accent, cursor: saving ? "wait" : "pointer" }}>{saving ? "Saving…" : "Save sourced event"}</button>
        {saveMessage && <span role="status" style={{ color: T.textSub, fontSize: 11 }}>{saveMessage}</span>}
      </div>
    </section>}
    {!loading && events.filter((event) => event.event_type === "election_control_change" || event.event_type === "federal_policy_action").slice(0, 25).map((event) => {
      const contextRaw = event.market_policy_event_context;
      const context = Array.isArray(contextRaw) ? contextRaw[0] : contextRaw;
      return <section key={event.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10, marginBottom: 8 }}>
        <div style={{ display: "flex", gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}><strong style={{ color: T.text, fontSize: 12 }}>{context?.event_title ?? event.event_type}</strong><span style={{ color: T.muted, fontSize: 10 }}>{context?.stage_status} · public {new Date(event.occurred_at).toLocaleString()}</span></div>
        {context?.family === "election" && <div style={{ color: T.textSub, fontSize: 11, marginTop: 4 }}>{context.chamber}: {context.previous_control} → {context.resulting_control}</div>}
        {context?.family === "federal_policy" && <div style={{ color: T.textSub, fontSize: 11, marginTop: 4 }}>Domain: {context.policy_domain}</div>}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>Chain ID: {context?.policy_chain_id}</div>
        <div style={{ color: T.textSub, fontSize: 11, marginTop: 4 }}>{context?.source_evidence}</div>
        <a href={event.source_url} target="_blank" rel="noreferrer" style={{ color: T.accent, fontSize: 10 }}>Primary source: {event.source_name} ↗</a>
        <div style={{ overflowX: "auto", marginTop: 7 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}><thead><tr>{["Symbol", "Exposure evidence", "1s", "5s", "20s", "60s"].map((label) => <th key={label} style={{ textAlign: "left", color: T.muted, borderBottom: `1px solid ${T.border}`, padding: 5 }}>{label}</th>)}</tr></thead><tbody>{(context?.market_policy_event_exposures ?? []).map((exposure: any) => <tr key={exposure.symbol}><td style={{ color: T.text, padding: 5 }}>{exposure.symbol}</td><td style={{ color: T.textSub, padding: 5 }}>{exposure.exposure_stance} · {exposure.rationale}<br/><a href={exposure.source_url} target="_blank" rel="noreferrer" style={{ color: T.accent }}>{exposure.source_name} ↗</a></td>{[1, 5, 20, 60].map((horizon) => { const outcome = event.policy_outcomes?.find((row: any) => row.subject_symbol === exposure.symbol && row.horizon_days === horizon); return <td key={horizon} style={{ color: outcome?.benchmark_neutral_return == null ? T.muted : Number(outcome.benchmark_neutral_return) >= 0 ? T.green : T.amber, padding: 5 }}>{outcome ? <>{(Number(outcome.benchmark_neutral_return ?? outcome.fwd_return) * 100).toFixed(2)}%{outcome.benchmark_neutral_return == null ? " raw" : " vs SPY"}<div style={{ color: T.textSub, marginTop: 2 }}>{outcome.matched_control_delta == null ? `control ${outcome.matched_control_n}/20` : `${(Number(outcome.matched_control_delta) * 100).toFixed(2)}pp vs matched`}</div><div style={{ color: T.muted, marginTop: 2 }}>daily vol {outcome.forward_volatility == null ? "—" : `${(Number(outcome.forward_volatility) * 100).toFixed(2)}%`} · close DD {outcome.max_drawdown == null ? "—" : `${(Number(outcome.max_drawdown) * 100).toFixed(2)}%`}</div></> : "Pending"}</td>; })}</tr>)}</tbody></table></div>
        <div style={{ color: T.muted, fontSize: 10, marginTop: 6 }}>Matched control is the 20 closest prior non-event windows by SPY's preceding 20-session return and volatility, only when 20 complete aligned windows exist. Control windows can overlap, so their count is not an effective sample size. It is descriptive, not causal or a strategy. Same-event symbols are not independent event replications.</div>
      </section>;
    })}
    {!loading && !error && latestTariffs.length > 0 && <div style={{ marginBottom: "12px" }}>
      <div style={{ color: newestTariffAgeDays != null && newestTariffAgeDays > 30 ? T.amber : T.muted, fontSize: "11px", marginBottom: "8px" }}>
        Latest recorded tariff event: {newestTariffAgeDays} day{newestTariffAgeDays === 1 ? "" : "s"} ago{newestTariffAgeDays != null && newestTariffAgeDays > 30 ? " — ledger may not reflect current policy; verify the cited official source." : ""}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        {latestTariffs.map((event) => <div key={event.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 12px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ color: event.direction === "escalation" ? T.amber : T.green, fontSize: "11px", fontWeight: 700 }}>{event.event_type === "policy_tariff_announced" ? "Tariff announced / escalated" : "Tariff paused / reduced"}</span>
            <span style={{ color: T.muted, fontSize: "10px" }}>{new Date(event.occurred_at).toLocaleString()} · {event.market.toUpperCase()}</span>
          </div>
          <div style={{ color: T.textSub, fontSize: "11px", lineHeight: 1.55, marginTop: "5px" }}>{event.notes || `${event.source_name} official policy record`}</div>
          <a href={event.source_url} target="_blank" rel="noreferrer" style={{ color: T.accent, fontSize: "10px", display: "inline-block", marginTop: "5px" }}>Verify at {event.source_name} ↗</a>
        </div>)}
      </div>
    </div>}
    {!loading && !error && items.length > 0 && <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: "10px" }}>
      {upcoming && <section style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
        <div style={{ color: T.accent, fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase" }}>Next scheduled FOMC</div>
        <div style={{ color: T.text, fontSize: "18px", fontWeight: 700, marginTop: "5px" }}>{upcoming.scheduled_date}</div>
        <div style={{ color: T.muted, fontSize: "11px", marginTop: "6px" }}>Expected range is unavailable until a licensed expectation source is configured.</div>
      </section>}
      {latest && <section style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
        <div style={{ color: T.accent, fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase" }}>Latest official outcome</div>
        <div style={{ color: T.text, fontSize: "18px", fontWeight: 700, marginTop: "5px" }}>{range(latest.actual_target_lower, latest.actual_target_upper)}</div>
        <div style={{ color: T.muted, fontSize: "11px", marginTop: "6px" }}>Effective {latest.actual_effective_date ?? latest.scheduled_date} · surprise {latest.surprise_bps == null ? "not measurable" : `${latest.surprise_bps >= 0 ? "+" : ""}${latest.surprise_bps} bps`}</div>
      </section>}
      {latest?.impact_summary.map((summary) => <section key={summary.horizon_sessions} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
        <div style={{ color: T.accent, fontSize: "10px", letterSpacing: "0.08em", textTransform: "uppercase" }}>{summary.horizon_sessions}-session observed impact</div>
        {summary.largest_excess.length === 0
          ? <div style={{ color: T.muted, fontSize: "11px", marginTop: "8px" }}>Awaiting frozen daily-return coverage.</div>
          : <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "7px" }}>{summary.largest_excess.map((impact) => {
            const relative = impact.excess_return_pct != null;
            const value = Number(relative ? impact.excess_return_pct : impact.symbol_return_pct);
            return <div key={impact.symbol} style={{ display: "flex", justifyContent: "space-between", fontSize: "11px" }}><span style={{ color: T.text }}>{impact.symbol}</span><span style={{ color: value >= 0 ? T.green : T.amber }}>{value >= 0 ? "+" : ""}{value.toFixed(2)}%{relative ? " vs SPY" : " raw"}</span></div>;
          })}</div>}
      </section>)}
    </div>}
  </div>;
}
