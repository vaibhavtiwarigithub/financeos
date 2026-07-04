"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import PageHeader from "@/components/dashboard/PageHeader";

function NewsletterTab() {
  const supabase = createClient();
  const [newsletters, setNewsletters] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const T2 = {
    bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
    text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
    accent: "#6366F1", green: "#34D399", red: "#F87171",
  };

  useEffect(() => {
    supabase.from("newsletters")
      .select("id, edition, subject, sent_at, nav_at_send, signals_count, positions_count, resend_id")
      .order("sent_at", { ascending: false })
      .limit(30)
      .then(({ data }) => { setNewsletters(data ?? []); setLoading(false); });
  }, []);

  if (loading) return <div style={{ color: T2.muted, padding: "40px", textAlign: "center" }}>Loading newsletters...</div>;
  if (newsletters.length === 0) return (
    <div style={{ background: T2.card, border: `1px solid ${T2.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
      <div style={{ fontSize: "32px", marginBottom: "12px" }}>✉</div>
      <div style={{ fontWeight: 600, marginBottom: "8px", color: T2.text }}>No newsletters yet</div>
      <div style={{ fontSize: "13px", color: T2.textSub }}>Morning edition sends at 8:30 AM ET · Evening at 5:30 PM ET on weekdays</div>
      <div style={{ fontSize: "12px", color: T2.muted, marginTop: "8px" }}>Delivered to vterminater@gmail.com</div>
    </div>
  );

  if (selected) return (
    <div>
      <button onClick={() => setSelected(null)} style={{ background: "none", border: `1px solid ${T2.border}`, borderRadius: "6px", color: T2.textSub, padding: "6px 14px", fontSize: "13px", cursor: "pointer", marginBottom: "16px" }}>
        ← Back to list
      </button>
      <div style={{ background: T2.card, border: `1px solid ${T2.border}`, borderRadius: "12px", overflow: "hidden" }}>
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T2.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontWeight: 600, color: T2.text, fontSize: "14px" }}>{selected.subject}</div>
            <div style={{ color: T2.muted, fontSize: "11px", marginTop: "3px" }}>
              {new Date(selected.sent_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
            </div>
          </div>
          <span style={{ background: selected.edition === "morning" ? "#6366F122" : "#34D39922", color: selected.edition === "morning" ? T2.accent : T2.green, border: `1px solid ${selected.edition === "morning" ? "#6366F144" : "#34D39944"}`, borderRadius: "4px", fontSize: "10px", fontWeight: 700, padding: "2px 8px" }}>
            {selected.edition === "morning" ? "☀ MORNING" : "◑ EVENING"}
          </span>
        </div>
        <iframe
          srcDoc={selected.html_body}
          style={{ width: "100%", border: "none", minHeight: "700px", background: "#0D0F14" }}
          title="Newsletter preview"
        />
      </div>
    </div>
  );

  const loadFull = async (id: string) => {
    const { data } = await supabase.from("newsletters").select("*").eq("id", id).single();
    if (data) setSelected(data);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "13px", color: T2.muted }}>{newsletters.length} editions · sent to vterminater@gmail.com</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {newsletters.map(n => (
          <button key={n.id} onClick={() => loadFull(n.id)} style={{ background: T2.card, border: `1px solid ${T2.border}`, borderRadius: "10px", padding: "14px 18px", cursor: "pointer", textAlign: "left", width: "100%" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontWeight: 600, color: T2.text, fontSize: "13px" }}>{n.subject}</div>
                <div style={{ color: T2.muted, fontSize: "11px", marginTop: "3px" }}>
                  {new Date(n.sent_at).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                  {n.nav_at_send ? ` · NAV $${Number(n.nav_at_send).toFixed(0)}` : ""}
                  {n.signals_count > 0 ? ` · ${n.signals_count} signals` : ""}
                </div>
              </div>
              <span style={{ background: n.edition === "morning" ? "#6366F122" : "#34D39922", color: n.edition === "morning" ? T2.accent : T2.green, border: `1px solid ${n.edition === "morning" ? "#6366F144" : "#34D39944"}`, borderRadius: "4px", fontSize: "10px", fontWeight: 700, padding: "2px 8px", whiteSpace: "nowrap" }}>
                {n.edition === "morning" ? "☀ MORNING" : "◑ EVENING"}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", red: "#F87171", blue: "#60A5FA",
};

export default function IntelligencePage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState("analysis");
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [dailyCount, setDailyCount] = useState(0);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) return;
      supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
      supabase.rpc("get_daily_ai_count", { p_user_id: user.id }).then(({ data }) => setDailyCount(data ?? 0));
    });
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t) setTab(t);
  }, []);

  async function callAI(userPrompt: string, system?: string) {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: userPrompt, systemPrompt: system }),
    });
    const data = await res.json();
    if (data.limitReached) throw new Error(data.error);
    if (data.error) throw new Error(data.error);
    setDailyCount(c => c + 1);
    return data.text as string;
  }

  async function runAnalysis() {
    if (!prompt.trim()) return;
    setLoading(true); setResult("");
    try {
      const sys = `You are a world-class financial analyst. Market focus: ${profile?.market_focus}. Level: ${profile?.knowledge_level}.
Rules:
1. NEVER fabricate prices or data
2. Format: THESIS | CATALYSTS | RISKS | TECHNICAL SETUP | TRADE IDEA (entry/stop/target) | CONFIDENCE (X/100) | LEARN: [one key concept]
3. Be specific, data-driven, no fluff
4. Think like a top hedge fund PM`;
      const text = await callAI(prompt, sys);
      setResult(text);
    } catch (e: unknown) {
      setResult("Error: " + (e instanceof Error ? e.message : "Unknown error"));
    }
    setLoading(false);
  }

  // Morning Brief moved to the dashboard home + email briefing (single source).
  // The Intelligence "brief" tab was removed to avoid duplication (#11).

  const tier = profile?.subscription_tier ?? "elite";
  const limit = 9999;
  const inp: React.CSSProperties = { width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "14px", padding: "11px 14px", outline: "none" };

  return (
    <div>
      <PageHeader
        title="Intelligence"
        subtitle={`${dailyCount}/${limit === 9999 ? "∞" : limit} queries used today`}
        cadence="daily"
        whatItDoes="AI research hub — view today's agent signals, run ad-hoc symbol analysis, read the morning market brief, and compare Claude vs DeepSeek calls."
        whatToLookFor={[
          "Signals tab: high analyst_score (≥70) + direction='long' = strong buy candidate.",
          "Morning Brief: generated each day from portfolio + market context — read before trading.",
          "Analysis tab: type any symbol or question for instant LLM research.",
          "LLM Comparison: check if Claude and DeepSeek agree — consensus = higher conviction.",
        ]}
      />
      <div style={{ padding: "0 28px 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div />
        <div style={{ fontSize: "12px", color: T.muted }}>
          {dailyCount}/{limit === 9999 ? "∞" : limit} queries today
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px", borderBottom: `1px solid ${T.border}`, marginBottom: "24px" }}>
        {["analysis", "newsletter"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", borderBottom: tab === t ? `2px solid ${T.accent}` : "2px solid transparent", color: tab === t ? T.accent : T.muted, padding: "8px 16px", fontSize: "14px", cursor: "pointer", textTransform: "capitalize", marginBottom: "-1px" }}>{t}</button>
        ))}
      </div>

      {tab === "analysis" && (
        <div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "16px" }}>
            <div style={{ fontSize: "13px", color: T.muted, marginBottom: "12px" }}>
              Ask about any asset, macro theme, sector, or geopolitical event. Get full thesis + trade idea.
            </div>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={"Examples:\n• Analyze NVDA fundamentals. Is AI trade overextended?\n• Impact of Fed pause on gold and Indian equities\n• Bitcoin outlook post-halving\n• Compare RELIANCE vs HDFC Bank as India plays"}
              style={{ ...inp, minHeight: "120px", resize: "vertical" }}
              onKeyDown={e => { if (e.key === "Enter" && e.metaKey) runAnalysis(); }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
              <div style={{ fontSize: "12px", color: T.muted }}>⌘+Enter to run</div>
              <button onClick={runAnalysis} disabled={loading || !prompt.trim()} style={{ background: loading ? T.border : T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "10px 24px", fontSize: "14px", fontWeight: 600, cursor: loading ? "not-allowed" : "pointer" }}>
                {loading ? "Analyzing..." : "Run Analysis"}
              </button>
            </div>
          </div>

          {result && (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "14px", textTransform: "uppercase", letterSpacing: "0.06em" }}>Analysis</div>
              <div style={{ fontSize: "14px", color: T.textSub, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                {result.split("\n").map((line, i) => {
                  if (line.startsWith("LEARN:")) return <div key={i} style={{ background: "#0a2240", border: `1px solid ${T.blue}`, borderRadius: "6px", padding: "10px 14px", margin: "10px 0", color: T.blue }}>{line}</div>;
                  if (line.includes("BUY") || line.includes("LONG")) return <div key={i} style={{ color: T.green }}>{line}</div>;
                  if (line.includes("SELL") || line.includes("SHORT")) return <div key={i} style={{ color: T.red }}>{line}</div>;
                  if (line.match(/^[A-Z\s&:|]+$/)) return <div key={i} style={{ color: T.text, fontWeight: 600, marginTop: "10px" }}>{line}</div>;
                  return <div key={i}>{line}</div>;
                })}
              </div>
            </div>
          )}

        </div>
      )}

      {tab === "newsletter" && (
        <NewsletterTab />
      )}
      </div>
    </div>
  );
}
