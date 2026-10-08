"use client";

import { useEffect, useState } from "react";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", amber: "#FBBF24", blue: "#60A5FA" };

function stateLabel(state: string) { return state.replaceAll("_", " "); }

export default function NewListingsPanel() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/listing-candidates?market=us").then(async r => {
      const json = await r.json(); if (!r.ok) throw new Error(json.error ?? "Could not load candidates"); return json;
    }).then(setData).catch(e => setError(e instanceof Error ? e.message : "Could not load candidates"));
  }, []);

  if (error) return <div style={{ color: "#F87171", fontSize: "13px" }}>{error}</div>;
  if (!data) return <div style={{ color: T.muted, fontSize: "13px" }}>Loading new-listing evidence…</div>;
  const candidates = data.candidates as any[];
  return <div style={{ display: "grid", gap: "12px" }}>
    <div style={{ background: "#241E10", border: `1px solid ${T.amber}`, borderRadius: "10px", padding: "13px 15px", color: T.sub, fontSize: "12px", lineHeight: 1.55 }}>
      Evidence only — SEC filings and the daily Nasdaq Trader directory help discover issuers, but directory membership does not establish the first-trade date or broker support. Directory-observed and listed-observing candidates enter a small, fair-rotation research sample and are always entry-ineligible. This does not add watchlist members, admit paper trades, or authorize live orders.
    </div>
    {!candidates.length ? <div style={{ color: T.muted, fontSize: "13px" }}>No new-listing evidence has been collected yet. The scheduled SEC and exchange-directory collector will establish its baseline, then record later additions.</div> : candidates.map(candidate => {
      const filing = [...(candidate.issuer_filings ?? [])].sort((a: any, b: any) => String(b.filed_at).localeCompare(String(a.filed_at)))[0];
      return <div key={candidate.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "15px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, color: T.text }}>{candidate.company_name} {candidate.symbol ? `(${candidate.symbol})` : ""}</div>
          <span style={{ color: T.blue, fontSize: "11px", fontWeight: 700, textTransform: "uppercase" }}>{stateLabel(candidate.state)}</span>
        </div>
        <div style={{ marginTop: "8px", color: T.sub, fontSize: "12px", display: "flex", gap: "14px", flexWrap: "wrap" }}>
          <span>{String(candidate.issuer_key).startsWith("exchange-directory:") ? "Directory key" : "CIK"}: {candidate.issuer_key}</span><span>Exchange: {candidate.exchange ?? "unresolved"}</span><span>Type: {stateLabel(candidate.instrument_type)}</span><span>First trade: {candidate.first_trade_date ?? "unverified"}</span><span>Broker BUY: {candidate.latest_preflight_id ? "evidence recorded" : "not probed"}</span>
        </div>
        {["directory_observed", "listed_observing"].includes(candidate.state) && <div style={{ marginTop: "8px", color: T.muted, fontSize: "11px" }}>
          Research: rotating measure-only sample (up to 2 names per US run) · not entry-eligible · no paper/live order permission
        </div>}
        {filing && <a href={filing.primary_document_url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: "10px", fontSize: "12px", color: T.blue }}>Latest {filing.form} filing · {filing.filed_at}</a>}
        {candidate.source_url && <a href={candidate.source_url} target="_blank" rel="noreferrer" style={{ display: "inline-block", marginTop: "10px", marginRight: "14px", fontSize: "12px", color: T.blue }}>Discovery source</a>}
        {candidate.last_research_attempt_at && <span style={{ color: T.muted, fontSize: "11px" }}>Last research attempt: {new Date(candidate.last_research_attempt_at).toLocaleString()}</span>}
      </div>;
    })}
  </div>;
}
