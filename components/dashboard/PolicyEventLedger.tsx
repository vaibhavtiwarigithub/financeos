"use client";

import { useEffect, useState } from "react";

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

function range(lower: number | null, upper: number | null) {
  return lower == null || upper == null ? "Not published" : `${lower.toFixed(2)}%–${upper.toFixed(2)}%`;
}

export default function PolicyEventLedger() {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/markets/policy-events")
      .then(async (response) => ({ ok: response.ok, body: await response.json() }))
      .then(({ ok, body }) => {
        if (!active) return;
        if (!ok) throw new Error(body?.error ?? "policy-event ledger unavailable");
        setItems(body.items ?? []);
      })
      .catch((cause) => active && setError(cause instanceof Error ? cause.message : "policy-event ledger unavailable"))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const upcoming = items.filter((item) => item.status === "scheduled").sort((a, b) => a.scheduled_date.localeCompare(b.scheduled_date))[0];
  const latest = items.filter((item) => item.status === "decided").sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date))[0];

  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start", flexWrap: "wrap", marginBottom: "14px" }}>
      <div>
        <div style={{ fontSize: "11px", color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "4px" }}>FOMC Decision Ledger · US</div>
        <div style={{ fontSize: "12px", color: T.textSub }}>Official range outcomes plus frozen post-event returns. Context only.</div>
      </div>
      <span style={{ fontSize: "10px", color: T.amber, border: `1px solid ${T.amber}55`, borderRadius: "999px", padding: "3px 8px" }}>Expectation feed unavailable</span>
    </div>
    {loading && <div style={{ height: "62px", background: T.surface, borderRadius: "8px", animation: "pulse 1.5s ease-in-out infinite" }} />}
    {!loading && error && <div style={{ color: T.muted, fontSize: "12px" }}>Ledger unavailable: {error}</div>}
    {!loading && !error && !items.length && <div style={{ color: T.muted, fontSize: "12px" }}>Awaiting the first policy-event sync.</div>}
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
