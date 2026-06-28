"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

export default function SettingsPage() {
  const supabase = createClient();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState("profile");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) supabase.from("profiles").select("*").eq("id", user.id).single().then(({ data }) => setProfile(data));
    });
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t) setTab(t);
  }, []);

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
  const tabs = ["profile", "preferences", "access"];

  if (!profile) return <div style={{ padding: "28px", color: T.muted }}>Loading...</div>;

  return (
    <div style={{ padding: "28px" }}>
      {toast && <div style={{ position: "fixed", top: "16px", right: "16px", background: T.card, border: `1px solid ${T.green}`, borderRadius: "8px", padding: "10px 16px", color: T.green, fontSize: "13px", zIndex: 9999 }}>{toast}</div>}

      <div style={{ fontSize: "20px", fontWeight: 600, marginBottom: "24px" }}>Settings</div>

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
  );
}
