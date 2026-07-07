"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import PageHeader from "@/components/dashboard/PageHeader";
import { usePrivacySetting } from "@/components/dashboard/PrivacyMask";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
  amber: "#F59E0B", amberBg: "#2D2000",
};

const RISK_PROFILES = {
  conservative: {
    label: "Conservative", icon: "🛡️",
    desc: "Lower risk, tighter stops, higher conviction required · max 2 positions/sector",
    score_threshold: 72, position_size_pct: 7, stop_loss_pct: 5, target_pct: 12, max_positions_per_sector: 2,
    activeBg: "#0D2410", activeBorder: "#34D399", activeText: "#34D399",
  },
  balanced: {
    label: "Balanced", icon: "⚖️",
    desc: "Default — mix of growth and safety · max 3 positions/sector",
    score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7, target_pct: 20, max_positions_per_sector: 3,
    activeBg: "#1E1F3A", activeBorder: "#6366F1", activeText: "#6366F1",
  },
  aggressive: {
    label: "Aggressive", icon: "🚀",
    desc: "Higher risk, wider stops, momentum-first · max 4 positions/sector",
    score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10, target_pct: 35, max_positions_per_sector: 4,
    activeBg: "#2D1800", activeBorder: "#F59E0B", activeText: "#F59E0B",
  },
} as const;

type RiskProfileKey = keyof typeof RISK_PROFILES;

type LLMCosts = {
  todayCost: number;
  weekCost: number;
  monthCost: number;
  burnRateHourly: number;
  projectedDaily: number;
  todayCalls: number;
  weekCalls: number;
  hourlyBreakdown: { hour: number; cost: number }[];
  byModel: Record<string, { cost: number; calls: number }>;
  alerts: string[];
};

export default function SettingsPage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState("profile");
  const [privacyEnabled, setPrivacyEnabled] = usePrivacySetting();
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  // Trading + broker state
  const [tradingMode, setTradingMode] = useState<"disabled" | "manual" | "auto">("manual");
  const [broker, setBroker] = useState<"robinhood" | "alpaca_paper" | "alpaca_live">("robinhood");
  const [savingTrading, setSavingTrading] = useState(false);

  // Broker registry (Ops spec Part 2) — per-market active broker
  const [brokerList, setBrokerList] = useState<{ us: { id: string; envs: string[]; configured: boolean }[]; india: { id: string; envs: string[]; configured: boolean }[] } | null>(null);
  const [activeBrokerUs, setActiveBrokerUs] = useState("alpaca");
  const [activeBrokerIndia, setActiveBrokerIndia] = useState("kite");
  const [savingBroker, setSavingBroker] = useState(false);

  // Per-market auto-trading on/off (view-only holdings unaffected either way)
  const [tradingEnabledUs, setTradingEnabledUs] = useState(true);
  const [tradingEnabledIndia, setTradingEnabledIndia] = useState(true);
  const [savingTradingEnabled, setSavingTradingEnabled] = useState(false);

  // Robinhood MCP scaffolding (OAuth connect is not yet wired — blocked on
  // Robinhood's real endpoints). Account allowlist + snapshot-source switch.
  const [rhMcp, setRhMcp] = useState<{ connected: boolean; enabled: boolean; live_account_source: string; oauth_ready: boolean } | null>(null);
  const [brokerAccounts, setBrokerAccounts] = useState<{ broker: string; market: string; account_number: string; label?: string; role: string }[]>([]);
  const [activeAccountUs, setActiveAccountUs] = useState<string>("");
  const [activeAccountIndia, setActiveAccountIndia] = useState<string>("");
  const [rhMcpMsg, setRhMcpMsg] = useState<string>("");
  const loadRhMcp = () => {
    fetch("/api/robinhood-mcp/status").then(r => r.json()).then(setRhMcp).catch(() => {});
    fetch("/api/broker-accounts").then(r => r.json()).then(d => setBrokerAccounts(d.accounts ?? [])).catch(() => {});
  };

  // Risk profile state
  const [riskProfile, setRiskProfile] = useState<RiskProfileKey>("balanced");
  const [scoreThreshold, setScoreThreshold] = useState(60);
  const [positionSizePct, setPositionSizePct] = useState(10);
  const [stopLossPct, setStopLossPct] = useState(7);
  const [targetPct, setTargetPct] = useState(20);
  const [savingRisk, setSavingRisk] = useState(false);

  // Posture (Part B) + champion-override note (A3) state
  const [posture, setPosture] = useState<RiskProfileKey | null>(null);
  const [postureExpiresAt, setPostureExpiresAt] = useState<string | null>(null);
  const [baseRiskProfile, setBaseRiskProfile] = useState<RiskProfileKey | null>(null);
  const [postureSelect, setPostureSelect] = useState<RiskProfileKey>("aggressive");
  const [postureDays, setPostureDays] = useState(30);
  const [savingPosture, setSavingPosture] = useState(false);
  const [hasChampion, setHasChampion] = useState(false);

  // LLM cost monitor state
  const [llmCosts, setLlmCosts] = useState<LLMCosts | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);

  // Zerodha Kite (India) connection state
  const [kite, setKite] = useState<any | null>(null);
  const [kiteMsg, setKiteMsg] = useState<string>("");
  const loadKite = () => fetch("/api/kite/status").then(r => r.json()).then(setKite).catch(() => {});

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
    });
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab");
    if (t) setTab(t);
    // Post-Kite-redirect status flag
    const k = params.get("kite");
    if (k) {
      const map: Record<string, string> = {
        connected: "Zerodha Kite connected — token valid for today.",
        login_failed: "Kite login failed or was cancelled.",
        exchange_failed: "Kite token exchange failed — check API secret in the Vault.",
        missing_key: "Add KITE_API_KEY and KITE_API_SECRET to Admin → API Vault first.",
      };
      setKiteMsg(map[k] ?? "");
      setTab("agents");
    }
    // Post-Robinhood-MCP-OAuth status flag
    const rh = params.get("rhmcp");
    if (rh) {
      const rmap: Record<string, string> = {
        connected: "Robinhood MCP connected — token stored.",
        register_failed: "Robinhood dynamic client registration failed.",
        state_mismatch: "OAuth state check failed — please retry the connect.",
        exchange_failed: "Token exchange failed — please retry.",
        no_client: "No registered client — retry the connect.",
      };
      setRhMcpMsg(rmap[rh] ?? "");
      setTab("agents");
    }

    // Load current risk profile
    fetch("/api/settings/risk-profile")
      .then(r => r.json())
      .then(d => {
        if (d.trading_mode) setTradingMode(d.trading_mode as any);
        if (d.broker) setBroker(d.broker as any);
        if (d.risk_profile) setRiskProfile(d.risk_profile as RiskProfileKey);
        if (d.score_threshold != null) setScoreThreshold(d.score_threshold);
        if (d.position_size_pct != null) setPositionSizePct(parseFloat(d.position_size_pct));
        if (d.stop_loss_pct != null) setStopLossPct(parseFloat(d.stop_loss_pct));
        if (d.target_pct != null) setTargetPct(parseFloat(d.target_pct));
        if (d.posture) setPosture(d.posture as RiskProfileKey);
        if (d.posture_expires_at) setPostureExpiresAt(d.posture_expires_at);
        if (d.base_risk_profile) setBaseRiskProfile(d.base_risk_profile as RiskProfileKey);
        if (d.active_broker_us) setActiveBrokerUs(d.active_broker_us);
        if (d.active_broker_india) setActiveBrokerIndia(d.active_broker_india);
        if (d.trading_enabled_us !== undefined && d.trading_enabled_us !== null) setTradingEnabledUs(d.trading_enabled_us);
        if (d.trading_enabled_india !== undefined && d.trading_enabled_india !== null) setTradingEnabledIndia(d.trading_enabled_india);
        if (d.active_account_us) setActiveAccountUs(d.active_account_us);
        if (d.active_account_india) setActiveAccountIndia(d.active_account_india);
      })
      .catch(() => {});

    // A3: does a promoted champion exist for the active market? (scoring weights overridden)
    supabase.from("strategy_versions").select("id").eq("is_champion", true).limit(1)
      .then(({ data }) => setHasChampion(!!data && data.length > 0), () => {});

    fetch("/api/brokers").then(r => r.json()).then(setBrokerList).catch(() => {});
  }, []);

  async function saveBrokerRegistry() {
    setSavingBroker(true);
    try {
      await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active_broker_us: activeBrokerUs, active_broker_india: activeBrokerIndia }),
      });
      setToast("Broker selection saved!");
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingBroker(false); }
  }

  async function saveTradingEnabled(market: "us" | "india", value: boolean) {
    setSavingTradingEnabled(true);
    const prevUs = tradingEnabledUs, prevIndia = tradingEnabledIndia;
    if (market === "us") setTradingEnabledUs(value); else setTradingEnabledIndia(value);
    try {
      const res = await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(market === "us" ? { trading_enabled_us: value } : { trading_enabled_india: value }),
      });
      if (!res.ok) throw new Error("save failed");
      setToast(`${market === "us" ? "US" : "India"} auto-trading ${value ? "enabled" : "disabled"}`);
      setTimeout(() => setToast(""), 2500);
    } catch {
      // revert optimistic update on failure
      setTradingEnabledUs(prevUs);
      setTradingEnabledIndia(prevIndia);
      setToast("Failed to save — try again");
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingTradingEnabled(false); }
  }

  async function patchRisk(payload: Record<string, any>, okMsg: string) {
    const res = await fetch("/api/settings/risk-profile", {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setRhMcpMsg(d.error ?? "Save failed"); }
    else { setRhMcpMsg(okMsg); }
    setTimeout(() => setRhMcpMsg(""), 3000);
    return res.ok;
  }

  async function toggleRhMcpEnabled(next: boolean) {
    const ok = await patchRisk({ robinhood_mcp_enabled: next }, `Robinhood MCP ${next ? "enabled" : "disabled"}`);
    if (ok) setRhMcp(m => m ? { ...m, enabled: next } : m);
  }

  async function setLiveAccountSource(src: string) {
    const ok = await patchRisk({ live_account_source: src }, `Snapshot source: ${src === "robinhood_mcp" ? "Cloud (Robinhood MCP)" : "Local (Claude Code)"}`);
    if (ok) setRhMcp(m => m ? { ...m, live_account_source: src } : m);
  }

  async function setActiveAccount(market: "us" | "india", account: string) {
    if (market === "us") setActiveAccountUs(account); else setActiveAccountIndia(account);
    await patchRisk(market === "us" ? { active_account_us: account } : { active_account_india: account }, "Active trading account saved");
  }

  async function disconnectRhMcp() {
    if (!confirm("Wipe the stored Robinhood MCP token from this app? The authoritative kill switch is still Robinhood's own Agentic Trading dashboard.")) return;
    const res = await fetch("/api/robinhood-mcp/disconnect", { method: "POST" });
    const d = await res.json().catch(() => ({}));
    setRhMcpMsg(res.ok ? "Robinhood MCP token wiped." : (d.error ?? "Disconnect failed"));
    setTimeout(() => setRhMcpMsg(""), 3000);
    loadRhMcp();
  }

  async function applyPosture() {
    setSavingPosture(true);
    try {
      const res = await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posture: postureSelect, posture_days: postureDays }),
      });
      const d = await res.json();
      if (d.posture) { setPosture(d.posture); setPostureExpiresAt(d.posture_expires_at); setBaseRiskProfile(d.base_risk_profile); setRiskProfile(d.posture); }
      setToast(`Posture ${postureSelect} applied for ${postureDays}d`);
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingPosture(false); }
  }

  async function cancelPosture() {
    setSavingPosture(true);
    try {
      const res = await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ posture: null }),
      });
      const d = await res.json();
      setPosture(null); setPostureExpiresAt(null); setBaseRiskProfile(null);
      if (d.risk_profile) setRiskProfile(d.risk_profile);
      setToast("Posture canceled — reverted to base profile");
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingPosture(false); }
  }

  // Fetch LLM costs + Kite status when agents tab becomes active
  useEffect(() => {
    if (tab !== "agents") return;
    loadKite();
    loadRhMcp();
    if (llmCosts) return; // already loaded
    setLlmLoading(true);
    fetch("/api/admin/llm-costs")
      .then(r => r.json())
      .then(d => setLlmCosts(d))
      .catch(() => {})
      .finally(() => setLlmLoading(false));
  }, [tab]);

  function selectRiskProfile(key: RiskProfileKey) {
    const p = RISK_PROFILES[key];
    setRiskProfile(key);
    setScoreThreshold(p.score_threshold);
    setPositionSizePct(p.position_size_pct);
    setStopLossPct(p.stop_loss_pct);
    setTargetPct(p.target_pct);
  }

  async function saveTradingConfig() {
    setSavingTrading(true);
    try {
      await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trading_mode: tradingMode, broker }),
      });
      setToast("Trading config saved!");
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingTrading(false); }
  }

  async function saveRiskProfile() {
    setSavingRisk(true);
    try {
      await fetch("/api/settings/risk-profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ risk_profile: riskProfile, score_threshold: scoreThreshold, position_size_pct: positionSizePct, stop_loss_pct: stopLossPct, target_pct: targetPct }),
      });
      setToast("Risk profile saved!");
      setTimeout(() => setToast(""), 2500);
    } finally {
      setSavingRisk(false);
    }
  }

  async function saveProfile() {
    if (!profile) return;
    setSaving(true);
    await supabase.from("profiles").update({
      full_name: profile.full_name,
      market_focus: profile.market_focus,
      knowledge_level: profile.knowledge_level,
      theme: profile.theme,
      ai_model: profile.ai_model,
    }).eq("id", profile.id);
    setSaving(false);
    setToast("Saved!");
    setTimeout(() => setToast(""), 2000);
  }

  const inp: React.CSSProperties = { width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "14px", padding: "10px 13px", outline: "none" };
  const sel: React.CSSProperties = { ...inp, cursor: "pointer" };
  const numInp: React.CSSProperties = { width: "90px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "14px", padding: "8px 10px", outline: "none", textAlign: "right" as const };
  const tabs = ["profile", "preferences", "agents", "access"];

  if (!profile) return <div style={{ padding: "28px", color: T.muted }}>Loading...</div>;

  return (
    <div>
      {toast && <div style={{ position: "fixed", top: "16px", right: "16px", background: T.card, border: `1px solid ${T.green}`, borderRadius: "8px", padding: "10px 16px", color: T.green, fontSize: "13px", zIndex: 9999 }}>{toast}</div>}

      <PageHeader
        title="Settings"
        subtitle="Profile, preferences, and access"
        cadence="as-needed"
        whatItDoes="Configure your display name, market focus, knowledge level, theme, and AI model preference. Access tab shows your role and tier."
        whatToLookFor={[
          "Market focus affects which data the agents prioritize (US vs India vs Both).",
          "Knowledge level changes how the Mentor explains concepts.",
          "AI model preference is used for chat — agents use the LLM router regardless.",
        ]}
      />

      <div style={{ padding: "0 28px 28px" }}>

      <div style={{ display: "flex", gap: "6px", marginBottom: "24px", borderBottom: `1px solid ${T.border}`, paddingBottom: "0" }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", borderBottom: tab === t ? `2px solid ${T.accent}` : "2px solid transparent", color: tab === t ? T.accent : T.muted, padding: "8px 16px", fontSize: "14px", cursor: "pointer", textTransform: "capitalize", marginBottom: "-1px" }}>{t}</button>
        ))}
      </div>

      {tab === "profile" && (
        <div style={{ maxWidth: "520px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Full name</label>
              <input value={profile.full_name || ""} onChange={e => setProfile({ ...profile, full_name: e.target.value })} style={inp} />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Email</label>
              <input value={profile.email} disabled style={{ ...inp, opacity: 0.6 }} />
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Market focus <span style={{ color: T.muted, fontWeight: 400 }}>(select all that apply)</span></label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {(["US", "India"] as const).map(m => {
                  const active = (profile.market_focus ?? "US").split(",").map(s => s.trim()).includes(m);
                  return (
                    <button key={m} type="button"
                      onClick={() => {
                        const current = (profile.market_focus ?? "US").split(",").map(s => s.trim()).filter(Boolean);
                        const next = active ? current.filter(x => x !== m) : [...current, m];
                        setProfile({ ...profile, market_focus: next.length ? next.join(",") : "US" });
                      }}
                      style={{
                        padding: "7px 16px", borderRadius: "20px", fontSize: "13px", fontWeight: 600, cursor: "pointer", border: "none",
                        background: active ? T.accent : T.surface,
                        color: active ? "#fff" : T.textSub,
                        outline: active ? `2px solid ${T.accent}` : `1px solid ${T.border}`,
                      }}
                    >{m}</button>
                  );
                })}
              </div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>
                Selected: {profile.market_focus || "US"} — turning on India makes the agents score NIFTY stocks (free Yahoo data) and run a separate ₹ paper pool with its own learning. Turning it off stops new India research/fills but keeps open India positions + history intact (non-destructive).
              </div>
            </div>
            <div style={{ marginBottom: "24px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Knowledge level</label>
              <select value={profile.knowledge_level} onChange={e => setProfile({ ...profile, knowledge_level: e.target.value as Profile["knowledge_level"] })} style={sel}>
                <option>Beginner</option><option>Intermediate</option><option>Advanced</option>
              </select>
            </div>
            <button onClick={saveProfile} disabled={saving} style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>
              {saving ? "Saving..." : "Save changes"}
            </button>
          </div>
        </div>
      )}

      {tab === "preferences" && (
        <div style={{ maxWidth: "520px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Theme</label>
              <select value={profile.theme} onChange={e => setProfile({ ...profile, theme: e.target.value as Profile["theme"] })} style={sel}>
                <option value="dark">Dark</option><option value="light">Light</option><option value="midnight">Midnight</option>
              </select>
            </div>
            <div style={{ marginBottom: "24px" }}>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>AI Model</label>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px" }}>
                This preference is not wired to the agent stack — ResearchAgent, TraderAgent, LearnerAgent, and MentorAgent each use a hardcoded model (DeepSeek / Groq via the LLM router) regardless of this setting. Claude options require <code style={{ color: T.textSub, background: T.card, padding: "1px 5px", borderRadius: "4px" }}>ANTHROPIC_API_KEY</code>, which is not currently configured.
              </div>
              <select value={profile.ai_model} onChange={e => setProfile({ ...profile, ai_model: e.target.value })} style={sel}>
                <option value="claude-sonnet">Claude Sonnet (requires ANTHROPIC_API_KEY — not configured)</option>
                <option value="claude-haiku">Claude Haiku (requires ANTHROPIC_API_KEY — not configured)</option>
              </select>
            </div>
            <button onClick={saveProfile} disabled={saving} style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>
              {saving ? "Saving..." : "Save preferences"}
            </button>
          </div>

          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginTop: "16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>Privacy Mode</div>
                <div style={{ fontSize: "12px", color: T.textSub, maxWidth: "380px" }}>
                  Hides live-account dollar amounts (equity, buying power, position values) behind an eye icon by default on Dashboard and Live Portfolio. Click the eye to reveal — it re-hides automatically when you leave and come back.
                </div>
              </div>
              <button
                onClick={() => setPrivacyEnabled(!privacyEnabled)}
                style={{
                  position: "relative", width: "44px", height: "24px", borderRadius: "12px", border: "none", cursor: "pointer", flexShrink: 0,
                  background: privacyEnabled ? T.accent : T.border,
                }}
              >
                <div style={{
                  position: "absolute", top: "2px", left: privacyEnabled ? "22px" : "2px",
                  width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left 0.15s",
                }} />
              </button>
            </div>
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div style={{ maxWidth: "560px" }}>

          {/* Trading Mode + Broker Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Live Trading</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "20px" }}>Controls whether the agent generates and executes real orders, and which broker to use.</div>

            {/* Trading mode */}
            <div style={{ marginBottom: "20px" }}>
              <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "10px" }}>Trading Mode</label>
              <div style={{ display: "flex", gap: "8px" }}>
                {([
                  { key: "disabled", label: "Disabled", desc: "No proposals generated", icon: "⛔", color: T.red },
                  { key: "manual",   label: "Manual",   desc: "Proposals require your approval", icon: "👁", color: T.yellow },
                  { key: "auto",     label: "Auto",     desc: "Auto-approve — future feature", icon: "⚡", color: T.green },
                ] as const).map(m => (
                  <button
                    key={m.key}
                    onClick={() => setTradingMode(m.key)}
                    disabled={m.key === "auto"}
                    style={{
                      flex: 1, padding: "12px 10px", borderRadius: "10px", cursor: m.key === "auto" ? "not-allowed" : "pointer",
                      background: tradingMode === m.key ? m.color + "22" : T.surface,
                      border: `2px solid ${tradingMode === m.key ? m.color : T.border}`,
                      color: tradingMode === m.key ? m.color : T.textSub,
                      textAlign: "left" as const, opacity: m.key === "auto" ? 0.5 : 1,
                    }}
                  >
                    <div style={{ fontSize: "16px", marginBottom: "3px" }}>{m.icon}</div>
                    <div style={{ fontSize: "13px", fontWeight: 700 }}>{m.label}</div>
                    <div style={{ fontSize: "10px", opacity: 0.8, marginTop: "2px" }}>{m.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Broker */}
            <div style={{ marginBottom: "20px" }}>
              <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "10px" }}>Execution Broker</label>
              <div style={{ display: "flex", flexDirection: "column" as const, gap: "8px" }}>
                {([
                  { key: "robinhood",    label: "Robinhood (via Claude MCP)", desc: "Official Robinhood MCP — requires Claude Code session. Slow (70-84s). No API key needed.", icon: "🐦" },
                  { key: "alpaca_paper", label: "Alpaca Paper", desc: "Alpaca paper trading — fast REST API. Add ALPACA_PAPER_API_KEY to Admin → Vault.", icon: "🦙" },
                  { key: "alpaca_live",  label: "Alpaca Live", desc: "Alpaca live trading — real money. Add ALPACA_API_KEY to Admin → Vault.", icon: "🦙💰" },
                ] as const).map(b => (
                  <button
                    key={b.key}
                    onClick={() => setBroker(b.key)}
                    style={{
                      padding: "12px 16px", borderRadius: "10px", cursor: "pointer", textAlign: "left" as const,
                      background: broker === b.key ? T.accentBg : T.surface,
                      border: `2px solid ${broker === b.key ? T.accent : T.border}`,
                      color: broker === b.key ? T.accent : T.textSub,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                      <span style={{ fontSize: "18px" }}>{b.icon}</span>
                      <div>
                        <div style={{ fontSize: "13px", fontWeight: 700 }}>{b.label}</div>
                        <div style={{ fontSize: "11px", opacity: 0.75, marginTop: "2px" }}>{b.desc}</div>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={saveTradingConfig}
              disabled={savingTrading}
              style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 600, cursor: "pointer", opacity: savingTrading ? 0.7 : 1 }}
            >
              {savingTrading ? "Saving..." : "Save Trading Config"}
            </button>

            {/* Broker registry (Ops spec Part 2) — per-market execution adapter */}
            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: "20px", paddingTop: "16px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "10px", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Execution Gateway broker (per market)</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>Keys go in Admin → Vault / .env — never entered here.</div>
              <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" as const }}>
                <div>
                  <label style={{ fontSize: "12px", color: T.textSub, display: "block", marginBottom: "6px" }}>US</label>
                  <select value={activeBrokerUs} onChange={e => setActiveBrokerUs(e.target.value)} style={numInp}>
                    {(brokerList?.us ?? [{ id: "alpaca", configured: false }]).map(b => (
                      <option key={b.id} value={b.id}>{b.id} {b.configured ? "✓" : "(not configured)"}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "12px", color: T.textSub, display: "block", marginBottom: "6px" }}>India</label>
                  <select value={activeBrokerIndia} onChange={e => setActiveBrokerIndia(e.target.value)} style={numInp}>
                    {(brokerList?.india ?? [{ id: "kite", configured: false }]).map(b => (
                      <option key={b.id} value={b.id}>{b.id} {b.configured ? "✓" : "(not configured)"}</option>
                    ))}
                  </select>
                </div>
                <button onClick={saveBrokerRegistry} disabled={savingBroker} style={{ alignSelf: "flex-end", background: "transparent", border: `1px solid ${T.accent}`, borderRadius: "8px", color: T.accent, padding: "8px 18px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                  {savingBroker ? "..." : "Save"}
                </button>
              </div>
            </div>

            {/* Per-market auto-trading on/off — separate from Disconnect below.
                Turning this off never blocks viewing holdings/balances; it only
                blocks new live order placement for that market. */}
            <div style={{ borderTop: `1px solid ${T.border}`, marginTop: "20px", paddingTop: "16px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "4px", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Auto-Trading On/Off (per market)</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "12px" }}>
                Off = you can still view holdings/balances and generate paper proposals, but no live order can be placed for that market. Different from Disconnect — this doesn't revoke any credential.
              </div>
              <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" as const }}>
                {([
                  { key: "us" as const, label: "🇺🇸 US (Robinhood/Alpaca)", enabled: tradingEnabledUs, setEnabled: setTradingEnabledUs },
                  { key: "india" as const, label: "🇮🇳 India (Kite)", enabled: tradingEnabledIndia, setEnabled: setTradingEnabledIndia },
                ]).map(m => (
                  <div key={m.key} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <button
                      onClick={() => saveTradingEnabled(m.key, !m.enabled)}
                      disabled={savingTradingEnabled}
                      style={{
                        position: "relative", width: "42px", height: "24px", borderRadius: "12px", border: "none", cursor: "pointer",
                        background: m.enabled ? T.green : T.border, opacity: savingTradingEnabled ? 0.6 : 1,
                      }}
                    >
                      <div style={{ position: "absolute", top: "2px", left: m.enabled ? "20px" : "2px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
                    </button>
                    <div style={{ fontSize: "13px", color: m.enabled ? T.green : T.muted }}>{m.label} — {m.enabled ? "auto-trading ON" : "view-only"}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Robinhood MCP (US live account + orders) — scaffolding */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Robinhood MCP · US</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "16px" }}>
              In-app Robinhood connection for the live-account snapshot and (once approved & connected) human-clicked order submission. Read-only viewing is unaffected by the auto-trading toggles above.
            </div>

            {rhMcpMsg && (
              <div style={{ fontSize: "13px", color: rhMcpMsg.toLowerCase().includes("fail") ? T.red : T.green, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "14px" }}>{rhMcpMsg}</div>
            )}

            {/* Connection status + connect/disconnect */}
            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" as const, marginBottom: "18px" }}>
              <div style={{ fontSize: "13px" }}>
                {!rhMcp ? <span style={{ color: T.muted }}>Checking…</span>
                  : rhMcp.connected ? <span style={{ color: T.green }}>● Connected</span>
                  : <span style={{ color: T.muted }}>○ Not connected</span>}
              </div>
              <button
                disabled={!rhMcp?.oauth_ready}
                title={rhMcp?.oauth_ready ? "" : "OAuth connect flow not yet configured — blocked on Robinhood's OAuth endpoints"}
                onClick={() => { if (rhMcp?.oauth_ready) window.location.href = "/api/robinhood-mcp/login"; }}
                style={{ background: rhMcp?.oauth_ready ? T.accent : T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: rhMcp?.oauth_ready ? "#fff" : T.muted, padding: "8px 18px", fontSize: "13px", fontWeight: 600, cursor: rhMcp?.oauth_ready ? "pointer" : "not-allowed" }}
              >
                {rhMcp?.oauth_ready ? "Connect" : "Connect (coming soon)"}
              </button>
              {rhMcp?.connected && (
                <button onClick={disconnectRhMcp} style={{ background: "transparent", border: `1px solid ${T.red}`, borderRadius: "8px", color: T.red, padding: "8px 18px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>Disconnect</button>
              )}
            </div>

            {/* Auto-trading enable for this integration (default off) */}
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "18px" }}>
              <button
                onClick={() => toggleRhMcpEnabled(!(rhMcp?.enabled))}
                style={{ position: "relative", width: "42px", height: "24px", borderRadius: "12px", border: "none", cursor: "pointer", background: rhMcp?.enabled ? T.green : T.border }}
              >
                <div style={{ position: "absolute", top: "2px", left: rhMcp?.enabled ? "20px" : "2px", width: "20px", height: "20px", borderRadius: "50%", background: "#fff", transition: "left 0.15s" }} />
              </button>
              <div style={{ fontSize: "13px", color: rhMcp?.enabled ? T.green : T.muted }}>
                Robinhood MCP {rhMcp?.enabled ? "enabled" : "disabled"} — dedicated kill switch (default off). When off, no new MCP calls; cached snapshot stays viewable.
              </div>
            </div>

            {/* Snapshot source switch */}
            <div style={{ marginBottom: "18px" }}>
              <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Live-account snapshot source</label>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" as const }}>
                {([
                  { key: "claude_exec", label: "Local — Windows Scheduler + Claude Code" },
                  { key: "robinhood_mcp", label: "Cloud — Robinhood MCP" },
                ] as const).map(s => {
                  const active = (rhMcp?.live_account_source ?? "claude_exec") === s.key;
                  return (
                    <button key={s.key} onClick={() => setLiveAccountSource(s.key)}
                      style={{ flex: "1 1 200px", padding: "10px 12px", borderRadius: "8px", cursor: "pointer", textAlign: "left" as const, fontSize: "12px", fontWeight: 600, background: active ? T.accentBg : T.surface, border: `2px solid ${active ? T.accent : T.border}`, color: active ? T.accent : T.textSub }}>
                      {s.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Active trading account selector (allowlist) */}
            <div style={{ marginBottom: "14px" }}>
              <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Active trading account (US)</label>
              <select value={activeAccountUs} onChange={e => setActiveAccount("us", e.target.value)} style={sel}>
                <option value="">— select —</option>
                {brokerAccounts.filter(a => a.market === "us" && a.role === "trading").map(a => (
                  <option key={a.account_number} value={a.account_number}>{a.label ?? a.account_number} ({a.account_number})</option>
                ))}
              </select>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>
                Only accounts you've marked <strong>trading</strong> in the allowlist appear here. View-only accounts can never be an order target.
              </div>
            </div>

            <div style={{ fontSize: "11px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "12px" }}>
              The authoritative, app-independent kill switch is revoking access from Robinhood's own Agentic Trading dashboard — that works even if this app or its database were compromised. Order placement is deliberately human-in-the-loop: no order is ever sent without your explicit approval + Send click.
            </div>
          </div>

          {/* Zerodha Kite (India) connection card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Zerodha Kite · India</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "16px" }}>
              Connects Indian-market (NSE/BSE) execution. Kite's token expires daily — click Connect each trading morning to refresh it. Requires KITE_API_KEY / KITE_API_SECRET in Admin → API Vault.
            </div>

            {kiteMsg && (
              <div style={{ fontSize: "13px", color: kiteMsg.includes("connected") ? T.green : T.amber, background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "14px" }}>{kiteMsg}</div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" as const }}>
              <div style={{ fontSize: "13px" }}>
                {!kite ? <span style={{ color: T.muted }}>Checking…</span>
                  : !kite.has_key ? <span style={{ color: T.red }}>● No API key in Vault</span>
                  : kite.connected ? <span style={{ color: T.green }}>● Connected{kite.profile?.user_name ? ` — ${kite.profile.user_name}` : ""} (token valid today)</span>
                  : kite.token_fresh ? <span style={{ color: T.amber }}>● Token present but a live call failed{kite.live_error ? `: ${kite.live_error}` : ""}</span>
                  : <span style={{ color: T.amber }}>● Not connected today — daily token needed</span>}
              </div>
              <a
                href="/api/kite/login"
                style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "9px 20px", fontSize: "13px", fontWeight: 600, textDecoration: "none" }}
              >
                {kite?.connected ? "Re-login" : "Connect Kite"}
              </a>
              {(kite?.connected || kite?.token_fresh) && (
                <button
                  onClick={async () => {
                    if (!confirm("Disconnect Kite now? This invalidates today's session with Zerodha and wipes the stored token — every Kite-dependent feature (India paper/live orders, position sync) stops working until you log in again.")) return;
                    setKiteMsg("Disconnecting…");
                    try {
                      const res = await fetch("/api/kite/disconnect", { method: "POST" });
                      const d = await res.json();
                      setKiteMsg(d.ok ? `Disconnected${d.remoteInvalidated ? " (session invalidated with Zerodha)" : " (local token cleared — Zerodha session invalidation failed, revoke manually at kite.zerodha.com if concerned)"}.` : `Disconnect failed: ${d.error ?? "unknown error"}`);
                    } catch (e) {
                      setKiteMsg(`Disconnect failed: ${String(e)}`);
                    }
                    loadKite();
                  }}
                  style={{ background: "transparent", border: `1px solid ${T.red}`, borderRadius: "8px", color: T.red, padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
                >
                  Disconnect
                </button>
              )}
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "10px" }}>
              The most reliable kill switch is revoking access directly at{" "}
              <a href="https://kite.zerodha.com" target="_blank" rel="noopener noreferrer" style={{ color: T.accent }}>kite.zerodha.com</a>
              {" "}or your Kite Connect apps page — that works even if this app were ever compromised. Disconnect above is the in-app-triggered complement to that.
            </div>
          </div>

          {/* Risk Profile Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Risk Profile</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "20px" }}>How aggressive should the agent be when picking and sizing trades?</div>

            {hasChampion && (
              <div style={{ background: T.amberBg, border: `1px solid ${T.amber}44`, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: T.amber }}>
                ⚠ A promoted champion currently overrides this profile's scoring weights (profile still controls sizing/exits/kill-switches).
              </div>
            )}

            {posture && (
              <div style={{ background: T.accentBg, border: `1px solid ${T.accent}66`, borderRadius: "8px", padding: "12px 16px", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: "8px" }}>
                <div style={{ fontSize: "13px", color: T.accent }}>
                  Posture: <b>{posture.toUpperCase()}</b>{postureExpiresAt ? ` until ${new Date(postureExpiresAt).toLocaleDateString()}` : ""} → reverts to {baseRiskProfile ?? "balanced"}
                </div>
                <button onClick={cancelPosture} disabled={savingPosture} style={{ background: "transparent", border: `1px solid ${T.accent}`, borderRadius: "6px", color: T.accent, padding: "5px 12px", fontSize: "12px", cursor: "pointer" }}>
                  {savingPosture ? "..." : "Cancel"}
                </button>
              </div>
            )}

            {/* Profile chips */}
            <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" as const }}>
              {(Object.keys(RISK_PROFILES) as RiskProfileKey[]).map(key => {
                const p = RISK_PROFILES[key];
                const isActive = riskProfile === key;
                return (
                  <button
                    key={key}
                    onClick={() => selectRiskProfile(key)}
                    style={{
                      flex: 1, minWidth: "130px", padding: "12px 14px",
                      background: isActive ? p.activeBg : T.surface,
                      border: `2px solid ${isActive ? p.activeBorder : T.border}`,
                      borderRadius: "10px", cursor: "pointer",
                      color: isActive ? p.activeText : T.textSub,
                      textAlign: "left" as const,
                    }}
                  >
                    <div style={{ fontSize: "18px", marginBottom: "4px" }}>{p.icon}</div>
                    <div style={{ fontSize: "14px", fontWeight: 600 }}>{p.label}</div>
                    <div style={{ fontSize: "11px", marginTop: "3px", opacity: 0.8 }}>{p.desc}</div>
                  </button>
                );
              })}
            </div>

            {/* Profile summary table */}
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px 16px", marginBottom: "20px", fontSize: "12px" }}>
              {(Object.keys(RISK_PROFILES) as RiskProfileKey[]).map(key => {
                const p = RISK_PROFILES[key];
                const isActive = riskProfile === key;
                return (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${T.border}`, color: isActive ? T.text : T.muted, fontWeight: isActive ? 600 : 400 }}>
                    <span>{p.icon} {p.label}</span>
                    <span style={{ color: T.textSub, fontFamily: "monospace" }}>
                      Score ≥{p.score_threshold} &nbsp;|&nbsp; {p.position_size_pct}% pos &nbsp;|&nbsp; -{p.stop_loss_pct}% stop &nbsp;|&nbsp; +{p.target_pct}% target
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Custom overrides */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: "16px", marginBottom: "20px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "14px", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Custom overrides</div>
              <div style={{ display: "grid", gap: "12px" }}>
                {[
                  { label: "Min score threshold", value: scoreThreshold, set: (v: number) => setScoreThreshold(v), step: 1, min: 0, max: 100 },
                  { label: "Position size %", value: positionSizePct, set: (v: number) => setPositionSizePct(v), step: 0.5, min: 1, max: 30 },
                  { label: "Stop loss %", value: stopLossPct, set: (v: number) => setStopLossPct(v), step: 0.5, min: 1, max: 25 },
                  { label: "Target %", value: targetPct, set: (v: number) => setTargetPct(v), step: 1, min: 5, max: 100 },
                ].map(({ label, value, set, step, min, max }) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <label style={{ fontSize: "13px", color: T.textSub }}>{label}</label>
                    <input
                      type="number"
                      value={value}
                      step={step}
                      min={min}
                      max={max}
                      onChange={e => set(parseFloat(e.target.value) || 0)}
                      style={numInp}
                    />
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={saveRiskProfile}
              disabled={savingRisk}
              style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 600, cursor: "pointer", opacity: savingRisk ? 0.7 : 1 }}
            >
              {savingRisk ? "Saving..." : "Save Profile"}
            </button>

            {/* Time-bound posture (Part B) — applies a profile with an expiry, auto-reverts */}
            {!posture && (
              <div style={{ borderTop: `1px solid ${T.border}`, marginTop: "20px", paddingTop: "16px" }}>
                <div style={{ fontSize: "12px", color: T.muted, marginBottom: "10px", letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Time-bound posture (auto-reverts)</div>
                <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" as const }}>
                  <select value={postureSelect} onChange={e => setPostureSelect(e.target.value as RiskProfileKey)} style={numInp}>
                    {(Object.keys(RISK_PROFILES) as RiskProfileKey[]).map(key => (
                      <option key={key} value={key}>{RISK_PROFILES[key].label}</option>
                    ))}
                  </select>
                  <select value={postureDays} onChange={e => setPostureDays(parseInt(e.target.value))} style={numInp}>
                    <option value={7}>1 week</option>
                    <option value={14}>2 weeks</option>
                    <option value={30}>1 month</option>
                    <option value={60}>2 months</option>
                  </select>
                  <button
                    onClick={applyPosture}
                    disabled={savingPosture}
                    style={{ background: "transparent", border: `1px solid ${T.accent}`, borderRadius: "8px", color: T.accent, padding: "8px 18px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
                  >
                    {savingPosture ? "..." : "Apply Posture"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* LLM Cost Monitor Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "16px" }}>LLM Cost Monitor</div>

            {llmLoading && (
              <div style={{ color: T.muted, fontSize: "13px" }}>Loading...</div>
            )}

            {!llmLoading && llmCosts && (
              <>
                {/* Summary row */}
                <div style={{ display: "flex", gap: "24px", marginBottom: "14px", flexWrap: "wrap" as const }}>
                  {[
                    { label: "Today", value: `$${llmCosts.todayCost.toFixed(4)}`, sub: `${llmCosts.todayCalls} calls` },
                    { label: "Week", value: `$${llmCosts.weekCost.toFixed(2)}`, sub: `${llmCosts.weekCalls} calls` },
                    { label: "Month", value: `$${llmCosts.monthCost.toFixed(2)}` },
                  ].map(({ label, value, sub }) => (
                    <div key={label}>
                      <div style={{ fontSize: "11px", color: T.muted, marginBottom: "2px" }}>{label}</div>
                      <div style={{ fontSize: "16px", fontWeight: 700, color: T.text }}>{value}</div>
                      {sub && <div style={{ fontSize: "10px", color: T.muted }}>{sub}</div>}
                    </div>
                  ))}
                </div>

                {/* Burn rate */}
                <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "14px" }}>
                  Burn rate: <span style={{ color: T.text, fontWeight: 600 }}>${llmCosts.burnRateHourly.toFixed(4)}/hr</span>
                  {" · "}
                  Projected today: <span style={{ color: llmCosts.projectedDaily > 5 ? T.amber : T.text, fontWeight: 600 }}>${llmCosts.projectedDaily.toFixed(3)}</span>
                </div>

                {/* Alerts */}
                {llmCosts.alerts.length > 0 && (
                  <div style={{ marginBottom: "14px", display: "flex", flexDirection: "column" as const, gap: "6px" }}>
                    {llmCosts.alerts.map((a, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", background: "#2D1B00", border: "1px solid #92400e", borderRadius: "8px" }}>
                        <span style={{ fontSize: "12px" }}>⚠️</span>
                        <span style={{ fontSize: "12px", color: T.amber }}>{a}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Per-model breakdown */}
                {Object.keys(llmCosts.byModel).length > 0 && (
                  <div style={{ marginBottom: "16px" }}>
                    <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: "8px" }}>Per-model (month)</div>
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: "4px" }}>
                      {Object.entries(llmCosts.byModel)
                        .sort((a, b) => b[1].cost - a[1].cost)
                        .map(([model, stats]) => (
                          <div key={model} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", padding: "4px 0", borderBottom: `1px solid ${T.border}44` }}>
                            <span style={{ color: T.textSub, fontFamily: "monospace", fontSize: "11px" }}>{model}</span>
                            <span style={{ color: T.text, fontWeight: 600 }}>
                              ${stats.cost.toFixed(4)}
                              <span style={{ color: T.muted, fontWeight: 400 }}> ({stats.calls} calls)</span>
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}

                {/* Hourly bar chart */}
                <div>
                  <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: "8px" }}>Hourly today</div>
                  {(() => {
                    const maxCost = Math.max(...llmCosts.hourlyBreakdown.map(h => h.cost), 0.001);
                    return (
                      <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 40 }}>
                        {llmCosts.hourlyBreakdown.map(h => (
                          <div
                            key={h.hour}
                            title={`${h.hour}:00 — $${h.cost.toFixed(4)}`}
                            style={{
                              flex: 1,
                              background: h.cost > 0 ? "#6366F1" : "#1E2130",
                              height: `${Math.max(2, (h.cost / maxCost) * 40)}px`,
                              borderRadius: 2,
                            }}
                          />
                        ))}
                      </div>
                    );
                  })()}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px", fontSize: "9px", color: T.muted }}>
                    <span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>11 PM</span>
                  </div>
                </div>
              </>
            )}

            {!llmLoading && !llmCosts && (
              <div style={{ color: T.muted, fontSize: "13px" }}>No LLM cost data available.</div>
            )}
          </div>
        </div>
      )}

      {tab === "access" && (
        <div style={{ maxWidth: "520px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "13px", color: T.muted, marginBottom: "4px" }}>Access level</div>
              <div style={{ fontSize: "22px", fontWeight: 700, color: profile.role === "superadmin" ? T.yellow : T.accent, textTransform: "capitalize" }}>
                {profile.role ?? "user"}
              </div>
              <div style={{ fontSize: "13px", color: T.textSub, marginTop: "4px" }}>Internal tool — full access</div>
            </div>
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "13px", color: T.muted, marginBottom: "4px" }}>Tier</div>
              <div style={{ fontSize: "18px", fontWeight: 600, textTransform: "capitalize" }}>
                {profile.subscription_tier ?? "elite"}
              </div>
            </div>
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "13px", color: T.muted, marginBottom: "4px" }}>Email</div>
              <div style={{ fontSize: "14px" }}>{profile.email}</div>
            </div>
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px 16px", fontSize: "12px", color: T.muted }}>
              Private internal tool. No billing or subscription required.
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
