"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import PageHeader from "@/components/dashboard/PageHeader";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
  amber: "#F59E0B", amberBg: "#2D2000",
};

const RISK_PROFILES = {
  conservative: {
    label: "Conservative", icon: "🛡️",
    desc: "Lower risk, tighter stops, higher conviction required",
    score_threshold: 72, position_size_pct: 7, stop_loss_pct: 5, target_pct: 12,
    activeBg: "#0D2410", activeBorder: "#34D399", activeText: "#34D399",
  },
  balanced: {
    label: "Balanced", icon: "⚖️",
    desc: "Default — mix of growth and safety",
    score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7, target_pct: 20,
    activeBg: "#1E1F3A", activeBorder: "#6366F1", activeText: "#6366F1",
  },
  aggressive: {
    label: "Aggressive", icon: "🚀",
    desc: "Higher risk, wider stops, momentum-first",
    score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10, target_pct: 35,
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
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  // Risk profile state
  const [riskProfile, setRiskProfile] = useState<RiskProfileKey>("balanced");
  const [scoreThreshold, setScoreThreshold] = useState(60);
  const [positionSizePct, setPositionSizePct] = useState(10);
  const [stopLossPct, setStopLossPct] = useState(7);
  const [targetPct, setTargetPct] = useState(20);
  const [savingRisk, setSavingRisk] = useState(false);

  // LLM cost monitor state
  const [llmCosts, setLlmCosts] = useState<LLMCosts | null>(null);
  const [llmLoading, setLlmLoading] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
    });
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t) setTab(t);

    // Load current risk profile
    fetch("/api/settings/risk-profile")
      .then(r => r.json())
      .then(d => {
        if (d.risk_profile) setRiskProfile(d.risk_profile as RiskProfileKey);
        if (d.score_threshold != null) setScoreThreshold(d.score_threshold);
        if (d.position_size_pct != null) setPositionSizePct(parseFloat(d.position_size_pct));
        if (d.stop_loss_pct != null) setStopLossPct(parseFloat(d.stop_loss_pct));
        if (d.target_pct != null) setTargetPct(parseFloat(d.target_pct));
      })
      .catch(() => {});
  }, []);

  // Fetch LLM costs when agents tab becomes active
  useEffect(() => {
    if (tab !== "agents") return;
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
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Market focus</label>
              <select value={profile.market_focus} onChange={e => setProfile({ ...profile, market_focus: e.target.value as Profile["market_focus"] })} style={sel}>
                <option>US</option><option>India</option><option>Both</option>
              </select>
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
              <select value={profile.ai_model} onChange={e => setProfile({ ...profile, ai_model: e.target.value })} style={sel}>
                <option value="claude-sonnet">Claude Sonnet (Recommended)</option>
                <option value="claude-haiku">Claude Haiku (Faster)</option>
              </select>
            </div>
            <button onClick={saveProfile} disabled={saving} style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 600, cursor: "pointer" }}>
              {saving ? "Saving..." : "Save preferences"}
            </button>
          </div>
        </div>
      )}

      {tab === "agents" && (
        <div style={{ maxWidth: "560px" }}>
          {/* Risk Profile Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px", marginBottom: "20px" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "6px" }}>Risk Profile</div>
            <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "20px" }}>How aggressive should the agent be when picking and sizing trades?</div>

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
