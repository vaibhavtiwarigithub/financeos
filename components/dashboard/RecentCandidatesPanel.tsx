"use client";

import { useEffect, useState } from "react";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", amber: "#FBBF24", red: "#F87171" };

export default function RecentCandidatesPanel({ market, book }: { market: "us" | "india"; book: "paper" | "live" }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") setRevision(value => value + 1);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setData(null); setError(null);
    fetch(`/api/portfolio/recent-candidates?market=${market}&book=${book}`, { signal: controller.signal, cache: "no-store" })
      .then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "Shortlist unavailable"); return result; })
      .then(result => { if (!controller.signal.aborted) setData(result); })
      .catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [market, book, revision]);
  return <section aria-label="Candidates waiting" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, marginBottom: 20, color: T.text }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
      <h2 style={{ fontSize: 15, margin: 0 }}>Candidates waiting{data ? ` · ${data.candidates.length}/20` : ""}</h2>
      <button onClick={() => setRevision(value => value + 1)} style={{ background: "transparent", color: T.textSub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "6px 10px", cursor: "pointer" }}>Refresh view</button>
    </div>
    <p style={{ color: T.textSub, fontSize: 12, lineHeight: 1.6 }}>Strong recent research is remembered for five market sessions. Stale candidates need new research before selection; this list cannot place orders. Leveraged ETFs and crypto use their own workflows.</p>
    {error ? <p role="alert" style={{ color: T.red }}>{error} — use Refresh view to retry.</p> : !data ? <p style={{ color: T.textSub }}>Loading shortlist…</p>
      : data.candidates.length === 0 ? <p style={{ color: T.textSub, fontSize: 12 }}>No retained qualified candidates yet. New qualifying regular-session research will populate this list.</p>
        : <details><summary style={{ cursor: "pointer", color: T.textSub, fontSize: 13 }}>View retained candidates and decisions</summary>
          <div role="region" aria-label="Retained candidate details" tabIndex={0} style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", minWidth: 650, borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>{["Rank / symbol", "Original → latest score", "Last assessed", "Sessions left", "Current state / last attempt"].map(label => <th key={label} style={{ textAlign: "left", color: T.textSub, padding: 8, borderBottom: `1px solid ${T.border}` }}>{label}</th>)}</tr></thead>
              <tbody>{data.candidates.map((row: any) => <tr key={row.id}>
                <td style={{ padding: 8, borderBottom: `1px solid ${T.border}` }}>{row.rank}. <a href={`/dashboard/symbol/${encodeURIComponent(row.symbol)}`} style={{ color: T.text }}>{row.symbol}</a></td>
                <td style={{ padding: 8 }}>{row.first_score} → {row.latest_score}</td>
                <td style={{ padding: 8 }}>{new Date(row.latest_at).toLocaleString()}<br /><span style={{ color: T.textSub }}>First: {row.first_session}</span></td>
                <td style={{ padding: 8 }}>{row.sessions_remaining}</td>
                <td style={{ padding: 8, maxWidth: 350 }}><span style={{ color: row.research_state === "needs_refresh" ? T.amber : T.textSub }}>{row.research_state.replaceAll("_", " ")}</span><br />{row.last_decision?.reason ?? (book === "live" ? "Live account, quote and risk gates checked at proposal time." : "No paper execution attempt recorded for these signals.")}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>}
  </section>;
}
