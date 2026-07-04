"use client";
import { useState, useEffect } from "react";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2A1A00",
};

interface Insight {
  grade: number | null; confidence: number | null;
  strengths: string[]; focus_areas: string[];
  lesson: string | null; market_note: string | null; next_milestone: string | null;
  created_at?: string; tokensOut?: number;
}

function gradeColor(g: number | null) {
  if (g == null) return T.muted;
  if (g >= 75) return T.green; if (g >= 55) return T.amber; return T.red;
}

export default function MentorCoachPanel() {
  const [insight, setInsight] = useState<Insight | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents/mentor-coach")
      .then(r => r.json())
      .then(d => { if (d.insight) setInsight(normalize(d.insight)); })
      .catch(() => {})
      .finally(() => setFetching(false));
  }, []);

  function normalize(a: any): Insight {
    return {
      grade: a.grade, confidence: a.confidence,
      strengths: a.strengths ?? [], focus_areas: a.focus_areas ?? [],
      lesson: a.lesson, market_note: a.market_note, next_milestone: a.next_milestone,
      created_at: a.created_at ?? a.createdAt,
    };
  }

  async function run() {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/agents/mentor-coach", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Mentor failed");
      setInsight(normalize(d));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }

  const stamp = insight?.created_at ? new Date(insight.created_at).toLocaleString() : null;
  const section = (title: string, color: string) => (
    <div style={{ fontSize: "11px", fontWeight: 800, letterSpacing: "0.08em", color, textTransform: "uppercase" as const, margin: "16px 0 8px" }}>{title}</div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <div style={{ fontSize: "15px", fontWeight: 700, color: T.text }}>🎓 AI Coach</div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
            A true agent — reads your behavior, learning progress, and the market regime, then coaches you. Educational only.
          </div>
        </div>
        <button onClick={run} disabled={loading}
          style={{ background: loading ? T.surface : T.accent + "22", border: `1px solid ${T.accent}`, color: T.accent, borderRadius: "8px", padding: "9px 16px", fontSize: "12px", fontWeight: 700, cursor: loading ? "wait" : "pointer" }}>
          {loading ? "Coaching… (30–60s)" : insight ? "↻ Re-run Coach" : "▶ Coach me"}
        </button>
      </div>

      {error && <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "12px", color: T.red, fontSize: "13px" }}>{error}</div>}

      {fetching && !insight && !loading && <div style={{ color: T.muted, fontSize: "12px", padding: "20px", textAlign: "center" }}>Checking for saved coaching…</div>}

      {!insight && !loading && !fetching && (
        <div style={{ color: T.muted, fontSize: "13px", padding: "30px", textAlign: "center", border: `1px dashed ${T.border}`, borderRadius: "10px" }}>
          No coaching yet. Click <b style={{ color: T.accent }}>Coach me</b> and the Mentor agent will assess your progress.
        </div>
      )}

      {insight && !loading && (
        <>
          {/* Grade hero */}
          <div style={{ background: T.surface, border: `1px solid ${gradeColor(insight.grade)}55`, borderRadius: "12px", padding: "16px 20px", display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: "30px", fontWeight: 800, color: gradeColor(insight.grade), lineHeight: 1 }}>{insight.grade ?? "—"}<span style={{ fontSize: "14px", color: T.muted }}>/100</span></div>
              <div style={{ fontSize: "10px", color: T.muted, marginTop: "3px" }}>discipline · progress</div>
            </div>
            {insight.confidence != null && (
              <div style={{ fontSize: "12px", color: T.textSub }}>Coach confidence: <b style={{ color: T.text }}>{Math.round(insight.confidence * 100)}%</b></div>
            )}
          </div>

          {insight.market_note && (
            <div style={{ background: T.blue + "12", border: `1px solid ${T.blue}33`, borderRadius: "10px", padding: "12px 14px", fontSize: "13px", color: T.textSub, lineHeight: 1.6 }}>
              <b style={{ color: T.blue }}>Market read:</b> {insight.market_note}
            </div>
          )}

          {insight.strengths?.length > 0 && <>
            {section("What you're doing well", T.green)}
            {insight.strengths.map((s, i) => <div key={i} style={{ fontSize: "13px", color: T.textSub, lineHeight: 1.55, marginBottom: "4px" }}>✓ {s}</div>)}
          </>}

          {insight.focus_areas?.length > 0 && <>
            {section("Focus on", T.amber)}
            {insight.focus_areas.map((s, i) => <div key={i} style={{ fontSize: "13px", color: T.textSub, lineHeight: 1.55, marginBottom: "4px" }}>→ {s}</div>)}
          </>}

          {insight.lesson && <>
            {section("Today's lesson", T.accent)}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", fontSize: "13.5px", color: T.text, lineHeight: 1.65 }}>{insight.lesson}</div>
          </>}

          {insight.next_milestone && <>
            {section("Next milestone", T.green)}
            <div style={{ fontSize: "13px", color: T.textSub, lineHeight: 1.6 }}>🎯 {insight.next_milestone}</div>
          </>}

          <div style={{ fontSize: "10px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "10px", marginTop: "6px" }}>
            MentorAgent · deepseek-reasoner{stamp ? ` · ${stamp}` : ""}
          </div>
        </>
      )}
    </div>
  );
}
