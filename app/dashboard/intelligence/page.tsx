"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";

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
  const [briefText, setBriefText] = useState("");
  const [briefLoading, setBriefLoading] = useState(false);
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

  async function genBrief() {
    setBriefLoading(true);
    try {
      const sys = `You are a financial morning brief writer. User: ${profile?.full_name}, Focus: ${profile?.market_focus}, Level: ${profile?.knowledge_level}.
Search for real current data. Format:
MARKET PULSE: Key overnight moves
MACRO: Fed/RBI/rates/macro
WATCHLIST: 3 setups to watch today
RISK: Main risk to watch
LEARN: One concept tied to today's conditions
Keep it under 400 words. Specific, not generic.`;
      const text = await callAI("Generate today's morning brief with current market conditions", sys);
      setBriefText(text);
      // Save to DB
      await supabase.from("brief_history").insert({ content: text });
    } catch (e: unknown) {
      setBriefText("Error: " + (e instanceof Error ? e.message : "Unknown"));
    }
    setBriefLoading(false);
  }

  const tier = profile?.subscription_tier ?? "free";
  const limit = tier === "free" ? 5 : tier === "pro" ? 50 : 9999;
  const inp: React.CSSProperties = { width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "14px", padding: "11px 14px", outline: "none" };

  return (
    <div style={{ padding: "28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div style={{ fontSize: "20px", fontWeight: 600 }}>Intelligence</div>
        <div style={{ fontSize: "12px", color: T.muted }}>
          {dailyCount}/{limit === 9999 ? "∞" : limit} queries today
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px", borderBottom: `1px solid ${T.border}`, marginBottom: "24px" }}>
        {["analysis", "brief", "newsletter"].map(t => (
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

          {tier === "free" && dailyCount >= 5 && (
            <div style={{ background: T.accentBg, border: `1px solid ${T.accent}40`, borderRadius: "12px", padding: "20px", textAlign: "center" }}>
              <div style={{ fontWeight: 600, marginBottom: "8px" }}>Daily limit reached</div>
              <div style={{ fontSize: "13px", color: T.textSub, marginBottom: "14px" }}>Upgrade to Pro for 50 queries/day</div>
              <a href="/dashboard/settings?tab=billing" style={{ background: T.accent, color: "#fff", borderRadius: "8px", padding: "10px 24px", fontSize: "14px", fontWeight: 600 }}>Upgrade to Pro</a>
            </div>
          )}
        </div>
      )}

      {tab === "brief" && (
        <div>
          {tier === "free" ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
              <div style={{ fontSize: "24px", marginBottom: "12px" }}>📰</div>
              <div style={{ fontWeight: 600, marginBottom: "8px" }}>Morning Brief is a Pro feature</div>
              <div style={{ fontSize: "13px", color: T.textSub, marginBottom: "20px" }}>Get a personalized AI-generated market brief every day</div>
              <a href="/dashboard/settings?tab=billing" style={{ background: T.accent, color: "#fff", borderRadius: "8px", padding: "10px 24px", fontSize: "14px", fontWeight: 600, textDecoration: "none" }}>Upgrade to Pro — $29/mo</a>
            </div>
          ) : (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div style={{ fontSize: "15px", fontWeight: 600 }}>Morning Brief</div>
                <button onClick={genBrief} disabled={briefLoading} style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "10px 22px", fontSize: "14px", fontWeight: 600, cursor: "pointer", opacity: briefLoading ? 0.7 : 1 }}>
                  {briefLoading ? "Generating..." : "Generate Brief"}
                </button>
              </div>
              {briefText ? (
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
                  <pre style={{ fontFamily: "'Inter', sans-serif", fontSize: "14px", color: T.textSub, lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{briefText}</pre>
                </div>
              ) : (
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "60px", textAlign: "center", color: T.muted }}>
                  Click Generate Brief to get your personalized daily update
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "newsletter" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
          <div style={{ fontSize: "24px", marginBottom: "12px" }}>✉️</div>
          <div style={{ fontWeight: 600, marginBottom: "8px" }}>Custom Newsletter</div>
          <div style={{ fontSize: "13px", color: T.textSub }}>
            {tier === "pro" || tier === "elite" ? "Generate your personalized financial newsletter" : "Upgrade to Pro to access the newsletter feature"}
          </div>
        </div>
      )}
    </div>
  );
}
