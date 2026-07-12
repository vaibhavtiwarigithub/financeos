"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import PageHeader from "@/components/dashboard/PageHeader";
import { useMarket } from "@/lib/market-context";
import SmartMoneyPage from "@/components/dashboard/SmartMoneyPage";

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
        <div style={{ padding: "14px 20px", borderBottom: `1px solid ${T2.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: "8px" }}>
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: "8px" }}>
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

const TM = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

const CAT_LABEL: Record<string, string> = {
  fundamental: "Fundamental", technical: "Technical", macro: "Macro", insider: "Insider / Flows", general: "General / Meta",
};

// ── Beliefs tab — surface + curate learning_priors ──────────────────────────
function BeliefsTab() {
  const [priors, setPriors] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ category: "fundamental", principle: "", confidence: "0.6", source: "user" });
  const [msg, setMsg] = useState("");

  const load = () => { setLoading(true); fetch("/api/agent-mind/priors").then(r => r.json()).then(d => { setPriors(d.priors ?? []); setLoading(false); }).catch(() => setLoading(false)); };
  useEffect(() => { load(); }, []);

  async function toggle(p: any) {
    setSaving(p.id);
    await fetch("/api/agent-mind/priors", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, enabled: !p.enabled }) }).catch(() => {});
    setSaving(null); load();
  }
  async function addPrior() {
    setMsg("");
    const res = await fetch("/api/agent-mind/priors", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "add", ...form, confidence: parseFloat(form.confidence) }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setMsg(d.error ?? "Failed"); return; }
    setAddOpen(false); setForm({ category: "fundamental", principle: "", confidence: "0.6", source: "user" }); load();
  }

  if (loading) return <div style={{ color: TM.muted, padding: "40px", textAlign: "center" }}>Loading beliefs…</div>;
  const byCat: Record<string, any[]> = {};
  for (const p of priors) (byCat[p.category] ??= []).push(p);
  const cats = Object.keys(CAT_LABEL).filter(c => byCat[c]?.length);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div style={{ fontSize: "13px", color: TM.textSub }}>
          The background principles the LearnerAgent reasons from ({priors.length} total). Confidence is earned over time as predictions resolve — the learner adjusts it; you can enable/disable or add your own.
        </div>
        <button onClick={() => setAddOpen(o => !o)} style={{ background: TM.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "8px 16px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>{addOpen ? "Cancel" : "+ Add belief"}</button>
      </div>

      {addOpen && (
        <div style={{ background: TM.card, border: `1px solid ${TM.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px" }}>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginBottom: "10px" }}>
            <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} style={{ background: TM.surface, border: `1px solid ${TM.border}`, borderRadius: "8px", color: TM.text, padding: "8px 10px" }}>
              {Object.entries(CAT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="number" step="0.05" min="0" max="1" value={form.confidence} onChange={e => setForm(f => ({ ...f, confidence: e.target.value }))} style={{ width: "90px", background: TM.surface, border: `1px solid ${TM.border}`, borderRadius: "8px", color: TM.text, padding: "8px 10px" }} placeholder="conf" />
            <input value={form.source} onChange={e => setForm(f => ({ ...f, source: e.target.value }))} style={{ width: "140px", background: TM.surface, border: `1px solid ${TM.border}`, borderRadius: "8px", color: TM.text, padding: "8px 10px" }} placeholder="source" />
          </div>
          <textarea value={form.principle} onChange={e => setForm(f => ({ ...f, principle: e.target.value }))} placeholder="One testable claim, e.g. 'Positive earnings-estimate revisions over 1-3 months predict continued outperformance.'" style={{ width: "100%", minHeight: "70px", background: TM.surface, border: `1px solid ${TM.border}`, borderRadius: "8px", color: TM.text, padding: "10px", boxSizing: "border-box" }} />
          {msg && <div style={{ color: TM.red, fontSize: "12px", marginTop: "8px" }}>{msg}</div>}
          <button onClick={addPrior} style={{ marginTop: "10px", background: TM.green, border: "none", borderRadius: "8px", color: "#04150c", padding: "8px 18px", fontSize: "13px", fontWeight: 700, cursor: "pointer" }}>Save belief</button>
        </div>
      )}

      {cats.map(cat => (
        <div key={cat} style={{ marginBottom: "22px" }}>
          <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.08em", color: TM.muted, textTransform: "uppercase", marginBottom: "10px" }}>{CAT_LABEL[cat]} · {byCat[cat].length}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {byCat[cat].map(p => {
              const pct = Math.round((p.confidence ?? 0) * 100);
              const barColor = pct >= 70 ? TM.green : pct >= 55 ? TM.amber : TM.red;
              return (
                <div key={p.id} style={{ background: TM.card, border: `1px solid ${TM.border}`, borderRadius: "10px", padding: "12px 14px", opacity: p.enabled ? 1 : 0.5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "flex-start" }}>
                    <div style={{ fontSize: "13px", color: TM.text, lineHeight: 1.5, flex: 1 }}>{p.principle}</div>
                    <button onClick={() => toggle(p)} disabled={saving === p.id} style={{ flexShrink: 0, background: p.enabled ? `${TM.green}22` : TM.surface, border: `1px solid ${p.enabled ? TM.green + "55" : TM.border}`, borderRadius: "6px", color: p.enabled ? TM.green : TM.muted, padding: "4px 10px", fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>{p.enabled ? "ON" : "OFF"}</button>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginTop: "8px" }}>
                    <div style={{ flex: 1, height: "6px", background: TM.surface, borderRadius: "3px", overflow: "hidden" }}>
                      <div style={{ width: `${pct}%`, height: "100%", background: barColor }} />
                    </div>
                    <div style={{ fontSize: "12px", color: barColor, fontWeight: 700, minWidth: "34px", textAlign: "right" }}>{pct}%</div>
                    <div style={{ fontSize: "11px", color: TM.muted, minWidth: "90px", textAlign: "right" }}>{p.source}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Brain tab — the unified evolving-belief view ────────────────────────────
function BrainTab() {
  const { market } = useMarket();
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); fetch(`/api/agent-mind/brain?market=${market}`).then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false)); }, [market]);

  if (loading) return <div style={{ color: TM.muted, padding: "40px", textAlign: "center" }}>Loading the brain…</div>;
  if (!data) return <div style={{ color: TM.muted, padding: "40px", textAlign: "center" }}>No brain data.</div>;

  const weights = data.champion?.weights_snapshot ?? data.live_weights ?? null;
  const dims = weights ? Object.entries(weights).filter(([k]) => /fundamental|technical|sentiment|macro|insider/i.test(k)) : [];
  const Section = ({ title, sub, children }: any) => (
    <div style={{ background: TM.card, border: `1px solid ${TM.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px" }}>
      <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.07em", color: TM.muted, textTransform: "uppercase", marginBottom: sub ? "2px" : "12px" }}>{title}</div>
      {sub && <div style={{ fontSize: "12px", color: TM.muted, marginBottom: "12px" }}>{sub}</div>}
      {children}
    </div>
  );

  const ev = data.evidence_context ?? {};
  return (
    <div>
      <div style={{ background: "#1a1200", border: `1px solid ${TM.amber}44`, borderRadius: "10px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: TM.amber }}>
        Evidence context: {ev.resolved_trades ?? 0} resolved trades, {ev.prior_count ?? 0} beliefs. Confidence is only as strong as the evidence behind it — treat everything below as a working view, not certainty.
      </div>

      <Section title="Current conviction" sub={data.champion ? `Champion strategy v${data.champion.version} — the current working theory of how much each dimension should matter` : "No promoted champion yet — using live default weights"}>
        {dims.length ? dims.map(([k, v]: any) => {
          const pct = Math.round(Number(v) * 100);
          return (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "6px" }}>
              <div style={{ width: "110px", fontSize: "12px", color: TM.textSub, textTransform: "capitalize" }}>{k.replace(/_weight/, "").replace(/_/g, " ")}</div>
              <div style={{ flex: 1, height: "8px", background: TM.surface, borderRadius: "4px", overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: TM.accent }} /></div>
              <div style={{ width: "40px", textAlign: "right", fontSize: "12px", color: TM.text, fontWeight: 700 }}>{pct}%</div>
            </div>
          );
        }) : <div style={{ color: TM.muted, fontSize: "13px" }}>No weight data.</div>}
        {data.champion?.notes && <div style={{ marginTop: "12px", fontSize: "12px", color: TM.textSub, lineHeight: 1.6, borderTop: `1px solid ${TM.border}`, paddingTop: "10px" }}>Why this is the theory: {data.champion.notes}</div>}
      </Section>

      <Section title="Strengthening / weakening beliefs" sub="How the confidence in each principle has moved as predictions resolved">
        {data.belief_drift?.length ? data.belief_drift.map((d: any) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
            <div style={{ width: "56px", fontSize: "12px", fontWeight: 700, color: d.delta > 0 ? TM.green : TM.red }}>{d.delta > 0 ? "▲" : "▼"} {Math.abs(Math.round(d.delta * 100))}%</div>
            <div style={{ flex: 1, fontSize: "12px", color: TM.textSub, lineHeight: 1.4 }}>{d.principle}</div>
            <div style={{ fontSize: "12px", color: TM.muted }}>{Math.round(d.current * 100)}%</div>
          </div>
        )) : <div style={{ color: TM.muted, fontSize: "13px" }}>No belief movement yet — drift appears once the learner has resolved predictions and adjusted confidence.</div>}
      </Section>

      <Section title="What the learner did recently" sub="Weight moves and notes from recent LearnerAgent runs">
        {data.learning_log?.length ? data.learning_log.map((l: any, i: number) => (
          <div key={i} style={{ borderBottom: i < data.learning_log.length - 1 ? `1px solid ${TM.border}` : "none", padding: "8px 0", fontSize: "12px", color: TM.textSub, lineHeight: 1.5 }}>
            <span style={{ color: TM.text, fontWeight: 600 }}>{l.signal_adjusted ?? "note"}</span>
            {l.old_weight != null && l.new_weight != null && <span> · {Number(l.old_weight).toFixed(2)} → {Number(l.new_weight).toFixed(2)}</span>}
            {l.trades_evaluated != null && <span style={{ color: TM.muted }}> · {l.trades_evaluated} trades</span>}
            <div>{l.reason ?? l.note ?? ""}</div>
          </div>
        )) : <div style={{ color: TM.muted, fontSize: "13px" }}>No learner activity logged yet.</div>}
      </Section>

      <Section title="Self-invented features" sub="Signals the system proposed for itself and where they sit in the IC-gated pipeline">
        {data.features?.length ? data.features.map((f: any, i: number) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", fontSize: "12px", color: TM.textSub }}>
            <span>{f.name}</span>
            <span style={{ color: f.status === "promoted" ? TM.green : f.status === "killed" ? TM.red : TM.amber, fontWeight: 700 }}>{f.status}</span>
          </div>
        )) : <div style={{ color: TM.muted, fontSize: "13px" }}>No self-proposed features yet.</div>}
      </Section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "16px" }}>
        <Section title="Regime posture">
          {data.regime ? (
            <div style={{ fontSize: "13px", color: TM.textSub, lineHeight: 1.6 }}>
              <div><span style={{ color: TM.text, fontWeight: 700, textTransform: "uppercase" }}>{data.regime.regime}</span> · danger {data.regime.danger_score}/100</div>
              {data.regime.summary && <div style={{ marginTop: "6px", fontSize: "12px" }}>{data.regime.summary}</div>}
            </div>
          ) : <div style={{ color: TM.muted, fontSize: "13px" }}>No macro regime yet.</div>}
        </Section>
        <Section title="Track record">
          {data.performance ? (
            <div style={{ fontSize: "13px", color: TM.textSub, lineHeight: 1.7 }}>
              <div>Total P&L: <span style={{ color: (data.performance.total_pnl_pct ?? 0) >= 0 ? TM.green : TM.red, fontWeight: 700 }}>{Number(data.performance.total_pnl_pct ?? 0).toFixed(1)}%</span></div>
              <div>Win rate: {data.performance.win_rate != null ? Math.round(data.performance.win_rate * (data.performance.win_rate <= 1 ? 100 : 1)) + "%" : "—"} ({(data.performance.win_count ?? 0)}W / {(data.performance.loss_count ?? 0)}L)</div>
              <div>Alpha vs benchmark: {data.performance.alpha_pct != null ? Number(data.performance.alpha_pct).toFixed(1) + "%" : "—"}</div>
            </div>
          ) : <div style={{ color: TM.muted, fontSize: "13px" }}>No performance data for this market yet.</div>}
        </Section>
      </div>
    </div>
  );
}

// ── Smart Money tab — merged in from the retired /dashboard/smart-money route.
// The SmartMoneyPage component needs its data as props (agent_signals /
// trade_proposals aren't client-readable), so we fetch the market-scoped set
// from the owner-gated API and pass it through. Market comes from useMarket().
function SmartMoneyTab() {
  const { market } = useMarket();
  const [data, setData] = useState<{ signals: any[]; tradeQueue: any[]; highInsider: any[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/markets/smart-money?market=${market}`)
      .then(r => r.json())
      .then(d => { setData({ signals: d.signals ?? [], tradeQueue: d.tradeQueue ?? [], highInsider: d.highInsider ?? [] }); setLoading(false); })
      .catch(() => { setData({ signals: [], tradeQueue: [], highInsider: [] }); setLoading(false); });
  }, [market]);

  if (loading || !data) return <div style={{ color: TM.muted, padding: "40px", textAlign: "center" }}>Loading smart money…</div>;
  return <SmartMoneyPage signals={data.signals} tradeQueue={data.tradeQueue} highInsider={data.highInsider} market={market} embedded />;
}

const TAB_LABELS: Record<string, string> = {
  analysis: "Analysis", "smart-money": "Smart Money", beliefs: "Beliefs", brain: "Brain", newsletter: "Newsletter",
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
        whatItDoes="AI research hub with five tabs: run ad-hoc symbol analysis, see where the big money is moving, review and curate the agent's beliefs, inspect the agent's reasoning, and preview the newsletter."
        whatToLookFor={[
          "Analysis: type any symbol or question for instant LLM research (thesis, catalysts, risks, trade idea, confidence).",
          "Smart Money: institutional/insider flow and the trade queue — high-insider names and where large players are buying.",
          "Beliefs: the agent's learned priors by category — toggle any on/off or add your own to steer future scoring.",
          "Brain: the agent-mind view of how signals were reasoned through, so you can see why it acted.",
          "Newsletter: preview the generated market newsletter before it goes out.",
        ]}
      />
      <div style={{ padding: "0 clamp(12px,4vw,28px) 28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div />
        <div style={{ fontSize: "12px", color: T.muted }}>
          {dailyCount}/{limit === 9999 ? "∞" : limit} queries today
        </div>
      </div>

      <div style={{ display: "flex", gap: "6px", borderBottom: `1px solid ${T.border}`, marginBottom: "24px" }}>
        {["analysis", "smart-money", "beliefs", "brain", "newsletter"].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", borderBottom: tab === t ? `2px solid ${T.accent}` : "2px solid transparent", color: tab === t ? T.accent : T.muted, padding: "8px 16px", fontSize: "14px", cursor: "pointer", whiteSpace: "nowrap", marginBottom: "-1px" }}>{TAB_LABELS[t] ?? t}</button>
        ))}
      </div>

      {tab === "analysis" && (
        <div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px" }}>
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
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px" }}>
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

      {tab === "smart-money" && <SmartMoneyTab />}
      {tab === "beliefs" && <BeliefsTab />}
      {tab === "brain" && <BrainTab />}

      {tab === "newsletter" && (
        <NewsletterTab />
      )}
      </div>
    </div>
  );
}
