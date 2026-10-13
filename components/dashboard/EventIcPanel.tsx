"use client";

import { useEffect, useMemo, useState } from "react";
import { Newspaper } from "lucide-react";
import { useMarket } from "@/lib/market-context";
import { eventVerdict } from "@/lib/llm-events/verdict";

// India LLM event extraction (shadow) evidence on the Learning page: does the event score add information beyond the deterministic
// composite and the LLM council, and is it redundant with the council? Viewer-safe stored aggregates (/api/learning/llm-events-ic).
// Cells are evidence only once they have enough independent windows; until then the panel says so instead of showing a verdict.

type Cell = { horizon_days: number; series_key: string; paired_observations: number; observation_count: number; qualifying_sessions: number; independent_windows: number; mean_session_rank_ic: number | null; sd_session_rank_ic: number | null; t_stat: number | null; classification: string; reason: string };
type Coverage = { date: string; ok: number; rejected: number; costUsd: number };
type ScoreRow = { symbol: string; score: number; items: number };
type Payload = {
  error?: string; evaluatedAt: string | null; cells: Cell[]; coverage: Coverage[];
  eventTypes: Array<{ type: string; count: number }>;
  scoreSummary: { asOf: string; symbols: number; highest: ScoreRow[]; lowest: ScoreRow[] } | null;
};

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24" };
const SERIES_LABEL: Record<string, string> = {
  "event:score": "Event score",
  "council:median_paired": "Council median (same sample)",
  "deterministic:analyst_score_paired": "Deterministic score (same sample)",
  "event:partial_vs_composite_council": "Event score, after removing composite + council",
  "corr:event_vs_council": "Correlation: event vs council",
  "corr:event_vs_composite": "Correlation: event vs composite",
};
const ORDER = Object.keys(SERIES_LABEL);
const VERDICT_COLOR = { collecting: T.amber, redundant: T.red, no_incremental_value: T.red, adds_information: T.green } as const;
const num = (v: number | null, digits = 3) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits));

export default function EventIcPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Payload | null>(null);
  const [horizon, setHorizon] = useState(10);
  const [error, setError] = useState("");

  useEffect(() => {
    if (market !== "india") return;
    let active = true;
    setData(null);
    fetch("/api/learning/llm-events-ic", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Event evidence unavailable (${r.status})`); return r.json(); })
      .then((b) => { if (active) { setData(b); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Event evidence unavailable"); });
    return () => { active = false; };
  }, [market]);

  const cells = useMemo(() => (data?.cells ?? []).filter((c) => c.horizon_days === horizon).sort((a, b) => ORDER.indexOf(a.series_key) - ORDER.indexOf(b.series_key)), [data, horizon]);
  const verdict = useMemo(() => eventVerdict(cells), [cells]);

  if (market !== "india") {
    return (
      <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "14px 20px", marginBottom: 24, color: T.sub, fontSize: 12 }}>
        <span style={{ color: T.text, fontWeight: 700 }}><Newspaper size={14} color={T.accent} style={{ verticalAlign: "-2px", marginRight: 6 }} />LLM event extraction</span> is measured for India only (US sentiment already has StockTwits, GDELT and Alpha Vantage news). Switch the market to India to see it.
      </section>
    );
  }

  const today = data?.coverage?.[0];
  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: T.text, fontSize: 15, fontWeight: 700 }}><Newspaper size={16} color={T.accent} /> LLM event extraction · India (shadow)</div>
          <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, marginTop: 6, maxWidth: 820 }}>
            A cheap model labels each India headline and NSE announcement on its own text only (blind to price and every score); code turns the labels into a per-symbol score.
            The test that matters is the partial IC: does it predict later benchmark-neutral returns after removing what the deterministic composite and the LLM council already explain?
            Measurement only: no trade, score or exit uses it.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[2, 5, 10, 20].map((h) => (
            <button key={h} onClick={() => setHorizon(h)} style={{ background: h === horizon ? T.accent : "transparent", color: h === horizon ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>h{h}</button>
          ))}
        </div>
      </div>

      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading event evidence…</div>}

      {data && (
        <>
          <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, border: `1px solid ${T.border}`, color: VERDICT_COLOR[verdict.state], fontSize: 12, lineHeight: 1.5 }}>
            <strong>Verdict at h{horizon}:</strong> {verdict.text}
          </div>
          <div style={{ color: T.muted, fontSize: 11, marginTop: 8 }}>
            {data.evaluatedAt ? `Last evaluation ${new Date(data.evaluatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "No evaluation yet"} ·
            {today ? ` latest extraction day ${today.date}: ${today.ok} labelled, ${today.rejected} rejected` : " no extraction in the last 14 days"}
          </div>

          {cells.length === 0 ? (
            <div style={{ color: T.sub, fontSize: 12, marginTop: 12 }}>No evaluated cells at h{horizon} yet. Scores need dated history, then h{horizon} sessions for returns to mature.</div>
          ) : (
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Series", "Pairs", "Sessions", "Independent windows", "Mean", "t-stat", "State"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
                <tbody>
                  {cells.map((c) => (
                    <tr key={c.series_key} style={{ borderTop: `1px solid ${T.border}`, color: T.text }} title={c.reason}>
                      <td style={{ padding: "5px 10px 5px 0" }}>{SERIES_LABEL[c.series_key] ?? c.series_key}</td>
                      <td style={{ padding: "5px 10px 5px 0" }}>{c.paired_observations}</td>
                      <td style={{ padding: "5px 10px 5px 0" }}>{c.qualifying_sessions}</td>
                      <td style={{ padding: "5px 10px 5px 0" }}>{num(c.independent_windows, 1)}</td>
                      <td style={{ padding: "5px 10px 5px 0", color: c.mean_session_rank_ic == null ? T.muted : c.mean_session_rank_ic >= 0 ? T.green : T.red }}>{num(c.mean_session_rank_ic)}</td>
                      <td style={{ padding: "5px 10px 5px 0" }}>{num(c.t_stat, 2)}</td>
                      <td style={{ padding: "5px 10px 5px 0", color: c.classification === "insufficient_evidence" ? T.amber : T.sub }}>{c.classification === "insufficient_evidence" ? "insufficient evidence" : "measured (descriptive)"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.scoreSummary && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16, marginTop: 18 }}>
              {([["Highest event scores", data.scoreSummary.highest], ["Lowest event scores", data.scoreSummary.lowest]] as const).map(([title, rows]) => (
                <div key={title}>
                  <div style={{ color: T.text, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{title} <span style={{ color: T.muted, fontWeight: 400 }}>({data.scoreSummary!.symbols} symbols, 50 = no net evidence)</span></div>
                  {rows.map((r) => (
                    <div key={r.symbol} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: T.text, borderTop: `1px solid ${T.border}`, padding: "4px 0" }}>
                      <span>{r.symbol}</span><span style={{ color: r.score >= 50 ? T.green : T.red }}>{r.score.toFixed(1)} <span style={{ color: T.muted }}>· {r.items} item{r.items === 1 ? "" : "s"}</span></span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          <div style={{ color: T.text, fontSize: 12, fontWeight: 600, margin: "18px 0 6px" }}>Extraction coverage (last 14 days)</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Day", "Labelled", "Rejected", "Model cost (USD)"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.coverage.map((c) => (
                  <tr key={c.date} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                    <td style={{ padding: "5px 10px 5px 0" }}>{c.date}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.ok}</td>
                    <td style={{ padding: "5px 10px 5px 0", color: c.rejected ? T.amber : T.text }}>{c.rejected}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.costUsd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.eventTypes.length > 0 && (
            <div style={{ color: T.muted, fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
              Event types seen: {data.eventTypes.map((e) => `${e.type.replace(/_/g, " ")} ${e.count}`).join(" · ")}
            </div>
          )}
        </>
      )}
    </section>
  );
}
