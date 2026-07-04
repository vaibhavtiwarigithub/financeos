"use client";
import { useState, useEffect } from "react";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24", purple: "#A78BFA",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

// Agent pipeline order + display labels
const STAGES: { key: string; label: string; group: string }[] = [
  { key: "market",             label: "Market / Technical", group: "Analysts" },
  { key: "sentiment",          label: "Sentiment / News",   group: "Analysts" },
  { key: "fundamentals",       label: "Fundamentals",       group: "Analysts" },
  { key: "macro",              label: "Macro",              group: "Analysts" },
  { key: "bull",               label: "Bull Advocate",      group: "Research Debate" },
  { key: "bear",               label: "Bear Advocate",      group: "Research Debate" },
  { key: "research_evaluator", label: "Research Evaluator", group: "Research Debate" },
  { key: "risk",               label: "Risk Desk",          group: "Risk" },
  { key: "portfolio_manager",  label: "Portfolio Manager",  group: "Verdict" },
];

function verdictColor(v: string) {
  const u = (v ?? "").toUpperCase();
  if (u === "BUY") return T.green;
  if (u === "SELL") return T.red;
  if (u === "HOLD") return T.amber;
  return T.muted; // PASS
}
function verdictBg(v: string) {
  const u = (v ?? "").toUpperCase();
  if (u === "BUY") return T.greenBg;
  if (u === "SELL") return T.redBg;
  if (u === "HOLD") return T.amberBg;
  return "#1A1D27";
}

interface Analysis {
  id?: string; symbol: string; verdict: string; conviction: number; summary: string;
  reports: Record<string, string>; model?: string;
  tokensIn?: number; tokensOut?: number; costUsd?: number; createdAt?: string;
  isHeld?: boolean; priorSignal?: { analyst_score: number; direction: string } | null;
}

export default function DeepDivePanel({ symbol }: { symbol: string }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch(`/api/agents/deep-dive?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => { if (d.analysis) setAnalysis(normalize(d.analysis)); })
      .catch(() => {})
      .finally(() => setFetching(false));
  }, [symbol]);

  function normalize(a: any): Analysis {
    return {
      id: a.id, symbol: a.symbol, verdict: a.verdict, conviction: a.conviction,
      summary: a.summary, reports: a.reports ?? {}, model: a.model,
      tokensIn: a.tokens_in ?? a.tokensIn, tokensOut: a.tokens_out ?? a.tokensOut,
      costUsd: a.cost_usd ?? a.costUsd, createdAt: a.created_at ?? a.createdAt,
      isHeld: a.isHeld, priorSignal: a.priorSignal,
    };
  }

  async function runDeepDive() {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/agents/deep-dive", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Deep-dive failed");
      setAnalysis(normalize(d));
      setExpanded(new Set(["portfolio_manager"]));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function toggle(k: string) {
    setExpanded(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  }

  const stamp = analysis?.createdAt ? new Date(analysis.createdAt).toLocaleString() : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* Header + run button */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: T.text }}>Deep-Dive Debate</div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
            9 agents: analysts → bull vs bear → risk desk → portfolio manager. Advisory; risk gate still governs.
          </div>
        </div>
        <button
          onClick={runDeepDive}
          disabled={loading}
          style={{
            background: loading ? T.surface : T.accent + "22", border: `1px solid ${T.accent}`, color: T.accent,
            borderRadius: "8px", padding: "9px 16px", fontSize: "12px", fontWeight: 700, cursor: loading ? "wait" : "pointer",
          }}
        >
          {loading ? "Debating… (30–90s)" : analysis ? "↻ Re-run Deep Analysis" : "▶ Run Deep Analysis"}
        </button>
      </div>

      {error && (
        <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "12px", color: T.red, fontSize: "13px" }}>
          {error}
        </div>
      )}

      {/* Loading pipeline animation */}
      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {STAGES.map((st, i) => (
            <div key={st.key} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: T.surface, borderRadius: "8px", border: `1px solid ${T.border}`, opacity: 0.5 + (i / STAGES.length) * 0.5 }}>
              <span style={{ color: T.accent, animation: "pulse 1.5s infinite" }}>◐</span>
              <span style={{ fontSize: "12px", color: T.textSub }}>{st.label}</span>
            </div>
          ))}
        </div>
      )}

      {fetching && !analysis && !loading && (
        <div style={{ color: T.muted, fontSize: "12px", padding: "20px", textAlign: "center" }}>Checking for saved analysis…</div>
      )}

      {!analysis && !loading && !fetching && (
        <div style={{ color: T.muted, fontSize: "13px", padding: "30px", textAlign: "center", border: `1px dashed ${T.border}`, borderRadius: "10px" }}>
          No deep analysis yet. Click <b style={{ color: T.accent }}>Run Deep Analysis</b> to have the agent team debate {symbol}.
        </div>
      )}

      {/* Verdict + reports */}
      {analysis && !loading && (
        <>
          {/* Verdict card */}
          <div style={{ background: verdictBg(analysis.verdict), border: `1px solid ${verdictColor(analysis.verdict)}55`, borderRadius: "12px", padding: "18px 20px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "24px", fontWeight: 800, color: verdictColor(analysis.verdict), letterSpacing: "0.02em" }}>
                {analysis.verdict}
              </span>
              <span style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>
                Conviction {analysis.conviction}/100
              </span>
              {analysis.priorSignal && (
                <span style={{ fontSize: "11px", color: T.muted }}>
                  · prior signal: {(analysis.priorSignal.direction ?? "").toUpperCase()} {analysis.priorSignal.analyst_score}/100
                </span>
              )}
              {analysis.isHeld && (
                <span style={{ fontSize: "10px", fontWeight: 700, color: T.amber, background: T.amberBg, padding: "2px 8px", borderRadius: "4px" }}>HELD</span>
              )}
            </div>
            {analysis.summary && (
              <div style={{ fontSize: "13px", color: T.textSub, lineHeight: 1.6, marginTop: "10px", whiteSpace: "pre-wrap" }}>
                {analysis.summary}
              </div>
            )}
          </div>

          {/* Agent pipeline with expandable reports */}
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {(() => {
              let lastGroup = "";
              return STAGES.map(st => {
                const report = analysis.reports?.[st.key];
                if (!report) return null;
                const showGroup = st.group !== lastGroup;
                lastGroup = st.group;
                const isOpen = expanded.has(st.key);
                return (
                  <div key={st.key}>
                    {showGroup && (
                      <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.08em", textTransform: "uppercase", margin: "8px 0 4px" }}>
                        {st.group}
                      </div>
                    )}
                    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", overflow: "hidden" }}>
                      <div onClick={() => toggle(st.key)} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 12px", cursor: "pointer" }}>
                        <span style={{ color: T.green, fontSize: "11px" }}>✓</span>
                        <span style={{ fontSize: "12px", fontWeight: 600, color: T.text, flex: 1 }}>{st.label}</span>
                        <span style={{ fontSize: "11px", color: T.muted }}>{isOpen ? "▲ hide report" : "▼ see report"}</span>
                      </div>
                      {isOpen && (
                        <div style={{ padding: "12px 14px", borderTop: `1px solid ${T.border}`, fontSize: "12.5px", color: T.textSub, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                          {report}
                        </div>
                      )}
                    </div>
                  </div>
                );
              });
            })()}
          </div>

          {/* Footer: model + cost */}
          <div style={{ fontSize: "10px", color: T.muted, display: "flex", gap: "12px", flexWrap: "wrap", borderTop: `1px solid ${T.border}`, paddingTop: "10px" }}>
            <span>model: {analysis.model}</span>
            {analysis.tokensIn != null && <span>tokens: {analysis.tokensIn?.toLocaleString()} in / {analysis.tokensOut?.toLocaleString()} out</span>}
            {analysis.costUsd != null && <span>cost: ${Number(analysis.costUsd).toFixed(4)}</span>}
            {stamp && <span>generated {stamp}</span>}
          </div>
        </>
      )}
      <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }`}</style>
    </div>
  );
}
