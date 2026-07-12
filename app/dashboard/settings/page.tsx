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
  const [rhMcp, setRhMcp] = useState<{ connected: boolean; stale?: boolean; expires_at?: string | null; has_refresh?: boolean; enabled: boolean; live_account_source: string; oauth_ready: boolean } | null>(null);
  const [brokerAccounts, setBrokerAccounts] = useState<{ broker: string; market: string; account_number: string; label?: string; role: string }[]>([]);
  const [activeAccountUs, setActiveAccountUs] = useState<string>("");
  const [activeAccountIndia, setActiveAccountIndia] = useState<string>("");
  const [rhMcpMsg, setRhMcpMsg] = useState<string>("");

  // Per-market live per-order notional caps (money limits — owner-set). Empty = null
  // = that market's live orders fail closed until a cap is set.
  const [usdCap, setUsdCap] = useState<string>("");
  const [inrCap, setInrCap] = useState<string>("");
  const [dailyUsd, setDailyUsd] = useState<string>("");
  const [dailyInr, setDailyInr] = useState<string>("");
  const [maxDailyTrades, setMaxDailyTrades] = useState<string>("");
  const [paperUsd, setPaperUsd] = useState<string>("");
  const [paperInr, setPaperInr] = useState<string>("");
  const [dailyPaperUsd, setDailyPaperUsd] = useState<string>("");
  const [dailyPaperInr, setDailyPaperInr] = useState<string>("");
  const [savingCaps, setSavingCaps] = useState(false);
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

  // Data Providers capacity dashboard
  const [providers, setProviders] = useState<any | null>(null);
  const [providersLoading, setProvidersLoading] = useState(false);
  const loadKite = () => fetch("/api/kite/status").then(r => r.json()).then(setKite).catch(() => {});

  // Autonomous trading (PA3 — per-market off/manual/autonomous)
  const [liveAuto, setLiveAuto] = useState<any | null>(null);
  const [liveAutoSaving, setLiveAutoSaving] = useState(false);
  const [liveAutoMsg, setLiveAutoMsg] = useState("");
  const [liveAutoConfirm, setLiveAutoConfirm] = useState("");
  const [liveAutoLeaseHours, setLiveAutoLeaseHours] = useState(4);
  const [liveAutoShowEnable, setLiveAutoShowEnable] = useState(false);
  const [liveAutoModeSaving, setLiveAutoModeSaving] = useState<string | null>(null);
  const [liveAutoCaps, setLiveAutoCaps] = useState({ daily_cap_usd: "", max_per_order_usd: "", min_confidence: "", max_positions: "", max_orders_per_day: "" });
  const loadLiveAuto = () => fetch("/api/settings/live-auto").then(r => r.json()).then(d => {
    setLiveAuto(d);
    setLiveAutoCaps({
      daily_cap_usd: d.live_auto_daily_cap_usd ?? "",
      max_per_order_usd: d.live_auto_max_per_order_usd ?? "",
      min_confidence: d.live_auto_min_evidence_confidence ?? "",
      max_positions: d.live_auto_max_open_positions ?? "",
      max_orders_per_day: d.live_auto_max_orders_per_day ?? "",
    });
  }).catch(() => {});

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
        if (d.max_order_notional_usd != null) setUsdCap(String(d.max_order_notional_usd));
        if (d.max_order_notional_inr != null) setInrCap(String(d.max_order_notional_inr));
        if (d.max_daily_notional_usd != null) setDailyUsd(String(d.max_daily_notional_usd));
        if (d.max_daily_notional_inr != null) setDailyInr(String(d.max_daily_notional_inr));
        if (d.max_daily_trades != null) setMaxDailyTrades(String(d.max_daily_trades));
        if (d.max_order_notional_usd_paper != null) setPaperUsd(String(d.max_order_notional_usd_paper));
        if (d.max_order_notional_inr_paper != null) setPaperInr(String(d.max_order_notional_inr_paper));
        if (d.max_daily_notional_usd_paper != null) setDailyPaperUsd(String(d.max_daily_notional_usd_paper));
        if (d.max_daily_notional_inr_paper != null) setDailyPaperInr(String(d.max_daily_notional_inr_paper));
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

  const ORDER_LIMIT_DEFAULTS = {
    usd: "500", inr: "20000", dailyUsd: "5000", dailyInr: "30000", maxDailyTrades: "",
    paperUsd: "2500", paperInr: "250000", dailyPaperUsd: "5000", dailyPaperInr: "500000",
  };

  async function saveOrderCaps() {
    // Empty per-order live field → null → that market fails closed (refuses live orders).
    // Empty daily / paper field → null → that limit is simply not enforced.
    const fields: [string, string][] = [["usd", usdCap], ["inr", inrCap], ["dailyUsd", dailyUsd], ["dailyInr", dailyInr],
      ["paperUsd", paperUsd], ["paperInr", paperInr], ["dailyPaperUsd", dailyPaperUsd], ["dailyPaperInr", dailyPaperInr]];
    for (const [, v] of fields) {
      if (v.trim() !== "" && !(Number(v) > 0)) {
        setToast("Amounts must be positive numbers (or blank)");
        setTimeout(() => setToast(""), 3000);
        return;
      }
    }
    if (maxDailyTrades.trim() !== "" && !(Number.isInteger(Number(maxDailyTrades)) && Number(maxDailyTrades) >= 1)) {
      setToast("Max daily trades must be a positive whole number (or blank)");
      setTimeout(() => setToast(""), 3000);
      return;
    }
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    setSavingCaps(true);
    try {
      await patchRisk({
        max_order_notional_usd: num(usdCap), max_order_notional_inr: num(inrCap),
        max_daily_notional_usd: num(dailyUsd), max_daily_notional_inr: num(dailyInr),
        max_daily_trades: num(maxDailyTrades),
        max_order_notional_usd_paper: num(paperUsd), max_order_notional_inr_paper: num(paperInr),
        max_daily_notional_usd_paper: num(dailyPaperUsd), max_daily_notional_inr_paper: num(dailyPaperInr),
      }, "Order limits saved");
      setToast("Order limits saved");
      setTimeout(() => setToast(""), 2500);
    } finally { setSavingCaps(false); }
  }

  function resetOrderLimitsToDefaults() {
    const d = ORDER_LIMIT_DEFAULTS;
    setUsdCap(d.usd); setInrCap(d.inr); setDailyUsd(d.dailyUsd); setDailyInr(d.dailyInr); setMaxDailyTrades(d.maxDailyTrades);
    setPaperUsd(d.paperUsd); setPaperInr(d.paperInr); setDailyPaperUsd(d.dailyPaperUsd); setDailyPaperInr(d.dailyPaperInr);
    setToast("Reset to defaults — click Save limits to apply");
    setTimeout(() => setToast(""), 3500);
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
    loadLiveAuto();
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
  const tabs = ["profile", "preferences", "agents", "data", "access"];

  useEffect(() => {
    if (tab !== "data" || providers) return;
    setProvidersLoading(true);
    fetch("/api/data-providers")
      .then(r => r.json())
      .then(d => setProviders(d))
      .catch(() => setProviders({ providers: [], bottleneck: null }))
      .finally(() => setProvidersLoading(false));
  }, [tab, providers]);

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

      <div style={{ padding: "0 clamp(12px,4vw,28px) 28px" }}>

      <div style={{ display: "flex", gap: "6px", marginBottom: "24px", borderBottom: `1px solid ${T.border}`, paddingBottom: "0" }}>
        {tabs.map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ background: "none", border: "none", borderBottom: tab === t ? `2px solid ${T.accent}` : "2px solid transparent", color: tab === t ? T.accent : T.muted, padding: "8px 16px", fontSize: "14px", cursor: "pointer", textTransform: "capitalize", marginBottom: "-1px" }}>{t}</button>
        ))}
      </div>

      {tab === "profile" && (
        <div style={{ maxWidth: "520px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
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

          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginTop: "16px" }}>
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Live Trading</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "20px" }}>Controls whether the agent generates and executes real orders, and which broker to use.</div>

            {/* Trading mode */}
            <div style={{ marginBottom: "20px" }}>
              <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "10px" }}>Trading Mode</label>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" as const }}>
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
                      flex: "1 1 140px", padding: "12px 10px", borderRadius: "10px", cursor: m.key === "auto" ? "not-allowed" : "pointer",
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px" }}>
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
                  : rhMcp.connected && rhMcp.stale ? (
                    <span style={{ color: T.red }} title={rhMcp.expires_at ? `Token expired ${new Date(rhMcp.expires_at).toLocaleString()}${rhMcp.has_refresh ? "" : " · no refresh token stored"}` : ""}>
                      ● Reconnect required — token expired
                    </span>
                  )
                  : rhMcp.connected ? (
                    <span style={{ color: T.green }} title={rhMcp.expires_at ? `Token valid until ${new Date(rhMcp.expires_at).toLocaleString()}` : ""}>
                      ● Connected{rhMcp.expires_at ? ` — valid until ${new Date(rhMcp.expires_at).toLocaleString()}` : ""}
                    </span>
                  )
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px" }}>
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

          {/* Live order limits — hard per-order notional ceiling, per market. */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Live Order Limits</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "16px" }}>
              Hard ceiling on the notional value (<code>qty × price</code>) of any single <strong>live</strong> order, checked at submit against a fresh quote. A blank field <strong>disables live trading for that market</strong> (fail-closed): the order is refused until you set a cap. Paper trades are unaffected.
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" as const, marginBottom: "14px" }}>
              <div style={{ flex: "1 1 160px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>US cap (USD $)</label>
                <input type="number" min="0" step="1" value={usdCap} onChange={e => setUsdCap(e.target.value)} placeholder="e.g. 50" style={sel} />
              </div>
              <div style={{ flex: "1 1 160px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>India cap (INR ₹)</label>
                <input type="number" min="0" step="1" value={inrCap} onChange={e => setInrCap(e.target.value)} placeholder="blank = India live disabled" style={sel} />
              </div>
            </div>
            <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "10px" }}>
              <strong>Daily limits</strong> — cumulative caps across all live BUY orders in one day (per market). SELL exits are never blocked. Blank = that limit is not enforced (per-order cap + kill switch still apply).
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" as const, marginBottom: "14px" }}>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Daily US ($)</label>
                <input type="number" min="0" step="1" value={dailyUsd} onChange={e => setDailyUsd(e.target.value)} placeholder="e.g. 150" style={sel} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Daily India (₹)</label>
                <input type="number" min="0" step="1" value={dailyInr} onChange={e => setDailyInr(e.target.value)} placeholder="e.g. 12000" style={sel} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Max trades / day</label>
                <input type="number" min="1" step="1" value={maxDailyTrades} onChange={e => setMaxDailyTrades(e.target.value)} placeholder="e.g. 3" style={sel} />
              </div>
            </div>
            <div style={{ fontSize: "12px", color: T.textSub, marginBottom: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              <strong>Paper limits</strong> — caps for the simulated ($10k / ₹1M) paper books, scaled to their NAV so they bound outliers without distorting the strategy. Blank = not enforced.
            </div>
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" as const, marginBottom: "14px" }}>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Paper US / trade ($)</label>
                <input type="number" min="0" step="1" value={paperUsd} onChange={e => setPaperUsd(e.target.value)} placeholder="e.g. 2500" style={sel} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Paper India / trade (₹)</label>
                <input type="number" min="0" step="1" value={paperInr} onChange={e => setPaperInr(e.target.value)} placeholder="e.g. 250000" style={sel} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Paper US / day ($)</label>
                <input type="number" min="0" step="1" value={dailyPaperUsd} onChange={e => setDailyPaperUsd(e.target.value)} placeholder="e.g. 5000" style={sel} />
              </div>
              <div style={{ flex: "1 1 120px" }}>
                <label style={{ fontSize: "12px", color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", display: "block", marginBottom: "8px" }}>Paper India / day (₹)</label>
                <input type="number" min="0" step="1" value={dailyPaperInr} onChange={e => setDailyPaperInr(e.target.value)} placeholder="e.g. 500000" style={sel} />
              </div>
            </div>
            <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" as const }}>
              <button onClick={saveOrderCaps} disabled={savingCaps}
                style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: savingCaps ? "default" : "pointer", opacity: savingCaps ? 0.6 : 1 }}>
                {savingCaps ? "Saving…" : "Save limits"}
              </button>
              <button onClick={resetOrderLimitsToDefaults} disabled={savingCaps}
                style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: "8px", color: T.textSub, padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}>
                Reset to defaults
              </button>
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "10px" }}>
              {inrCap.trim() === "" && <span style={{ color: T.amber }}>● India live orders are currently disabled (no INR cap set). </span>}
              Caps are per <em>single order</em>, not per day. They never affect paper trading and can only be changed here by you.
            </div>
          </div>

          {/* Risk Profile Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginBottom: "20px" }}>
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
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
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

          {/* Autonomous Trading (PA0 — schema/UI; deployment flag currently false) */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginTop: "20px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
              <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const }}>Autonomous Trading</div>
              {liveAuto && (
                <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "12px",
                  background: liveAuto.live_auto_enabled && liveAuto.deployment_flag_active ? "#0D2410" : "#1A1A2E",
                  color: liveAuto.live_auto_enabled && liveAuto.deployment_flag_active ? T.green : T.muted,
                  border: `1px solid ${liveAuto.live_auto_enabled && liveAuto.deployment_flag_active ? T.green : T.border}` }}>
                  {liveAuto.live_auto_enabled && liveAuto.deployment_flag_active ? "ACTIVE" : "INACTIVE"}
                </span>
              )}
            </div>
            <div style={{ fontSize: "13px", color: T.textSub, marginBottom: "16px" }}>
              Controls whether Kairos can submit live orders without your click. Both the deployment flag and this toggle must be enabled.
            </div>

            {/* Deployment flag status */}
            <div style={{ background: T.surface, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", display: "flex", gap: "10px", alignItems: "flex-start" }}>
              <span style={{ color: liveAuto?.deployment_flag_active ? T.green : T.red, fontSize: "16px", lineHeight: 1 }}>
                {liveAuto?.deployment_flag_active ? "✓" : "✗"}
              </span>
              <div>
                <div style={{ fontWeight: 600, color: liveAuto?.deployment_flag_active ? T.green : T.red }}>
                  Deployment flag: {liveAuto?.deployment_flag_active ? "ACTIVE" : "INACTIVE"}
                </div>
                <div style={{ color: T.muted, marginTop: "2px" }}>
                  {liveAuto?.deployment_flag_active
                    ? "AUTONOMOUS_LIVE_ENABLED=true in deployment config."
                    : "AUTONOMOUS_LIVE_ENABLED=false — no autonomous orders will be placed regardless of DB settings."}
                </div>
              </div>
            </div>

            {/* Current DB lease status */}
            {liveAuto && (
              <div style={{ marginBottom: "16px", fontSize: "13px" }}>
                <span style={{ color: T.muted }}>DB toggle: </span>
                <span style={{ color: liveAuto.live_auto_enabled ? T.yellow : T.textSub, fontWeight: 600 }}>
                  {liveAuto.live_auto_enabled ? "enabled" : "disabled"}
                </span>
                {liveAuto.live_auto_enabled_until && (
                  <span style={{ color: T.muted }}>
                    {" "}· lease expires {new Date(liveAuto.live_auto_enabled_until).toLocaleString()}
                  </span>
                )}
              </div>
            )}

            {/* Per-market mode */}
            <div style={{ background: T.surface, borderRadius: "8px", padding: "12px 14px", marginBottom: "16px" }}>
              <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: "10px" }}>Per-Market Mode</div>
              {(["us", "india"] as const).map((mkt) => {
                const col = mkt === "us" ? "live_auto_mode_us" : "live_auto_mode_india";
                const current: string = liveAuto?.[col] ?? "manual";
                const label = mkt === "us" ? "US (Robinhood)" : "India (Kite)";
                return (
                  <div key={mkt} style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px", flexWrap: "wrap" as const }}>
                    <span style={{ fontSize: "12px", color: T.textSub, minWidth: "120px" }}>{label}</span>
                    <div style={{ display: "flex", gap: "6px" }}>
                      {(["off", "manual", "autonomous"] as const).map((m) => {
                        const active = current === m;
                        const isAuto = m === "autonomous";
                        const disabled = isAuto && !liveAuto?.deployment_flag_active;
                        return (
                          <button
                            key={m}
                            disabled={liveAutoModeSaving === mkt || disabled}
                            title={disabled ? "Deployment flag must be active" : undefined}
                            onClick={async () => {
                              if (active) return;
                              setLiveAutoModeSaving(mkt); setLiveAutoMsg("");
                              try {
                                const r = await fetch("/api/settings/live-auto", {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ action: "update_mode", market: mkt, mode: m }),
                                });
                                const d = await r.json();
                                if (!r.ok) setLiveAutoMsg(d.error ?? "Failed");
                                else { loadLiveAuto(); }
                              } catch { setLiveAutoMsg("Request failed"); }
                              setLiveAutoModeSaving(null);
                            }}
                            style={{
                              padding: "5px 12px", fontSize: "12px", borderRadius: "6px", cursor: disabled || active ? "default" : "pointer",
                              fontWeight: active ? 700 : 400, opacity: disabled ? 0.4 : 1,
                              background: active
                                ? (m === "autonomous" ? "#0D2410" : m === "manual" ? "#1a1a2e" : T.surface)
                                : T.surface,
                              border: `1px solid ${active
                                ? (m === "autonomous" ? T.green : m === "manual" ? T.accent : T.border)
                                : T.border}`,
                              color: active
                                ? (m === "autonomous" ? T.green : m === "manual" ? T.accent : T.muted)
                                : T.muted,
                            }}
                          >
                            {liveAutoModeSaving === mkt && active ? "…" : m}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>
                off = no proposals · manual = Approve in dashboard · autonomous = cron submits live orders
              </div>
            </div>

            {/* Caps */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px,1fr))", gap: "10px", marginBottom: "16px" }}>
              {([
                ["Daily cap (USD)", "daily_cap_usd", "e.g. 500"],
                ["Max per-order (USD)", "max_per_order_usd", "e.g. 100"],
                ["Max open positions", "max_positions", "e.g. 5"],
                ["Max orders/day", "max_orders_per_day", "e.g. 3"],
              ] as const).map(([label, key, ph]) => (
                <div key={key}>
                  <label style={{ fontSize: "11px", color: T.muted, display: "block", marginBottom: "4px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>{label}</label>
                  <input
                    type="number"
                    placeholder={ph}
                    value={liveAutoCaps[key as keyof typeof liveAutoCaps]}
                    onChange={e => setLiveAutoCaps(c => ({ ...c, [key]: e.target.value }))}
                    style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none", boxSizing: "border-box" as const }}
                  />
                </div>
              ))}
            </div>
            <div style={{ marginBottom: "16px" }}>
              <label style={{ fontSize: "11px", color: T.muted, display: "block", marginBottom: "4px", textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Min evidence confidence (0–1, min 0.6)</label>
              <input
                type="number" step="0.05" min="0.6" max="1"
                placeholder="e.g. 0.75"
                value={liveAutoCaps.min_confidence}
                onChange={e => setLiveAutoCaps(c => ({ ...c, min_confidence: e.target.value }))}
                style={{ width: "140px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none" }}
              />
            </div>

            {/* Enable panel */}
            {!liveAuto?.live_auto_enabled && (
              <>
                {liveAutoShowEnable ? (
                  <div style={{ background: "#1A0A0A", border: `1px solid ${T.red}44`, borderRadius: "10px", padding: "16px", marginBottom: "12px" }}>
                    <div style={{ fontSize: "12px", color: T.red, fontWeight: 600, marginBottom: "10px" }}>
                      Type &quot;ENABLE AUTO&quot; to confirm
                    </div>
                    <input
                      value={liveAutoConfirm}
                      onChange={e => setLiveAutoConfirm(e.target.value)}
                      placeholder="ENABLE AUTO"
                      style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none", marginBottom: "10px", boxSizing: "border-box" as const }}
                    />
                    <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                      <label style={{ fontSize: "12px", color: T.muted }}>Lease duration:</label>
                      <select
                        value={liveAutoLeaseHours}
                        onChange={e => setLiveAutoLeaseHours(Number(e.target.value))}
                        style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "13px", padding: "6px 10px" }}
                      >
                        {[1, 2, 4, 8, 12, 24].map(h => <option key={h} value={h}>{h}h</option>)}
                      </select>
                    </div>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <button
                        disabled={liveAutoSaving || !liveAuto?.deployment_flag_active || liveAutoConfirm !== "ENABLE AUTO"}
                        onClick={async () => {
                          setLiveAutoSaving(true); setLiveAutoMsg("");
                          try {
                            const r = await fetch("/api/settings/live-auto", { method: "PATCH", headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ action: "enable", confirmation_text: liveAutoConfirm, lease_hours: liveAutoLeaseHours,
                                live_auto_daily_cap_usd: liveAutoCaps.daily_cap_usd || null,
                                live_auto_max_per_order_usd: liveAutoCaps.max_per_order_usd || null,
                                live_auto_min_evidence_confidence: liveAutoCaps.min_confidence || null,
                                live_auto_max_open_positions: liveAutoCaps.max_positions || null,
                                live_auto_max_orders_per_day: liveAutoCaps.max_orders_per_day || null,
                              }) });
                            const d = await r.json();
                            if (!r.ok) { setLiveAutoMsg(d.error ?? "Failed"); }
                            else { setLiveAutoMsg("Enabled."); setLiveAutoShowEnable(false); setLiveAutoConfirm(""); loadLiveAuto(); }
                          } catch { setLiveAutoMsg("Request failed"); }
                          setLiveAutoSaving(false);
                        }}
                        style={{ background: liveAutoConfirm === "ENABLE AUTO" && liveAuto?.deployment_flag_active ? T.red : T.surface,
                          border: `1px solid ${T.red}`, borderRadius: "8px", color: liveAutoConfirm === "ENABLE AUTO" && liveAuto?.deployment_flag_active ? "#fff" : T.red,
                          padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: liveAutoConfirm !== "ENABLE AUTO" || !liveAuto?.deployment_flag_active ? "not-allowed" : "pointer",
                          opacity: liveAutoSaving ? 0.7 : 1 }}
                      >
                        {liveAutoSaving ? "Enabling…" : "Enable Autonomous"}
                      </button>
                      <button onClick={() => { setLiveAutoShowEnable(false); setLiveAutoConfirm(""); }}
                        style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: "8px", color: T.muted, padding: "9px 16px", fontSize: "13px", cursor: "pointer" }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => setLiveAutoShowEnable(true)}
                    disabled={!liveAuto?.deployment_flag_active}
                    title={!liveAuto?.deployment_flag_active ? "Deployment flag must be true first" : undefined}
                    style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: liveAuto?.deployment_flag_active ? T.text : T.muted,
                      padding: "9px 20px", fontSize: "13px", cursor: liveAuto?.deployment_flag_active ? "pointer" : "not-allowed",
                      opacity: liveAuto?.deployment_flag_active ? 1 : 0.5, marginRight: "8px" }}>
                    Enable Autonomous…
                  </button>
                )}
              </>
            )}

            {/* Disable button */}
            {liveAuto?.live_auto_enabled && (
              <button
                disabled={liveAutoSaving}
                onClick={async () => {
                  setLiveAutoSaving(true); setLiveAutoMsg("");
                  const r = await fetch("/api/settings/live-auto", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "disable" }) }).catch(() => null);
                  const d = r ? await r.json() : null;
                  setLiveAutoMsg(r?.ok ? "Disabled." : (d?.error ?? "Failed"));
                  loadLiveAuto();
                  setLiveAutoSaving(false);
                }}
                style={{ background: "#2D0A0A", border: `1px solid ${T.red}`, borderRadius: "8px", color: T.red, padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: liveAutoSaving ? 0.7 : 1, marginRight: "8px" }}>
                {liveAutoSaving ? "Disabling…" : "Disable Autonomous"}
              </button>
            )}

            {/* Save caps independently */}
            <button
              disabled={liveAutoSaving}
              onClick={async () => {
                setLiveAutoSaving(true); setLiveAutoMsg("");
                const r = await fetch("/api/settings/live-auto", { method: "PATCH", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "update_caps",
                    live_auto_daily_cap_usd: liveAutoCaps.daily_cap_usd || null,
                    live_auto_max_per_order_usd: liveAutoCaps.max_per_order_usd || null,
                    live_auto_min_evidence_confidence: liveAutoCaps.min_confidence || null,
                    live_auto_max_open_positions: liveAutoCaps.max_positions || null,
                    live_auto_max_orders_per_day: liveAutoCaps.max_orders_per_day || null,
                  }) }).catch(() => null);
                const d = r ? await r.json() : null;
                setLiveAutoMsg(r?.ok ? "Caps saved." : (d?.error ?? "Failed"));
                loadLiveAuto();
                setLiveAutoSaving(false);
              }}
              style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: liveAutoSaving ? 0.7 : 1 }}>
              {liveAutoSaving ? "Saving…" : "Save Caps"}
            </button>

            {liveAutoMsg && (
              <div style={{ marginTop: "10px", fontSize: "13px", color: liveAutoMsg.includes("ailed") || liveAutoMsg.includes("error") ? T.red : T.green }}>
                {liveAutoMsg}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "data" && (
        <div style={{ maxWidth: "820px" }}>
          <div style={{ fontSize: "13px", color: T.textSub, marginBottom: "16px", lineHeight: 1.5 }}>
            Every external data source, its daily limit, real usage, and how much headroom is left — so you always know where the ceiling is before an agent starves. Rate-limited providers (Massive, Finnhub, Upstox, FRED) have no daily cap; only capped ones can run out.
          </div>

          {providers?.bottleneck && (
            <div style={{ background: T.amberBg, border: `1px solid ${T.amber}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "13px", color: T.amber }}>
              ⚠ Closest to its ceiling: <strong>{providers.bottleneck.label}</strong> at {providers.bottleneck.pctUsed}% of today&apos;s cap. That&apos;s your current bottleneck.
            </div>
          )}

          {providersLoading && <div style={{ color: T.muted, fontSize: "14px" }}>Loading provider usage…</div>}

          {providers?.providers?.length > 0 && (
            <div style={{ overflowX: "auto", border: `1px solid ${T.border}`, borderRadius: "12px" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px", minWidth: "640px" }}>
                <thead>
                  <tr style={{ background: T.surface, color: T.muted, textAlign: "left" as const }}>
                    <th style={{ padding: "10px 14px" }}>Provider</th>
                    <th style={{ padding: "10px 14px" }}>Key</th>
                    <th style={{ padding: "10px 14px" }}>Daily limit</th>
                    <th style={{ padding: "10px 14px" }}>Today</th>
                    <th style={{ padding: "10px 14px" }}>7-day avg</th>
                    <th style={{ padding: "10px 14px" }}>Headroom</th>
                    <th style={{ padding: "10px 14px" }}>Expiry</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.providers.map((p: any) => {
                    const expColor = p.daysToExpiry == null ? T.muted : p.daysToExpiry < 7 ? T.red : p.daysToExpiry < 30 ? T.amber : T.green;
                    const useColor = p.pctUsed == null ? T.textSub : p.pctUsed >= 90 ? T.red : p.pctUsed >= 60 ? T.amber : T.green;
                    return (
                      <tr key={p.id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                        <td style={{ padding: "10px 14px", fontWeight: 600 }}>{p.label}</td>
                        <td style={{ padding: "10px 14px" }}>{p.keyPresent ? <span style={{ color: T.green }}>✓</span> : <span style={{ color: T.red }}>missing</span>}</td>
                        <td style={{ padding: "10px 14px", color: T.textSub }}>{p.limit == null ? "no cap (rate-limited)" : p.limit.toLocaleString()}</td>
                        <td style={{ padding: "10px 14px", color: useColor }}>{p.todayCalls}{p.pctUsed != null ? ` (${p.pctUsed}%)` : ""}</td>
                        <td style={{ padding: "10px 14px", color: T.textSub }}>{p.avg7d}</td>
                        <td style={{ padding: "10px 14px", color: p.headroom == null ? T.textSub : p.headroom < (p.limit ?? 0) * 0.1 ? T.red : T.green }}>{p.headroom == null ? "—" : p.headroom.toLocaleString()}</td>
                        <td style={{ padding: "10px 14px", color: expColor }}>{p.daysToExpiry == null ? "never" : `${p.daysToExpiry}d`}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {providers && !providersLoading && !providers.providers?.length && (
            <div style={{ color: T.muted, fontSize: "14px" }}>No provider usage recorded yet — data appears after the agents run.</div>
          )}
        </div>
      )}

      {tab === "access" && (
        <div style={{ maxWidth: "520px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
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
