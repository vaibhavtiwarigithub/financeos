"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import { useRole } from "@/lib/auth/use-role";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

type Prefs = {
  riskEmail: { enabled: boolean; sendHourUtc: number; lastSentAt: string | null };
  newsletter: { optedIn: boolean };
};

const UTC_HOURS = Array.from({ length: 24 }, (_, i) => {
  const h = i.toString().padStart(2, "0");
  const label = i === 0 ? "12:00 AM (midnight)" : i < 12 ? `${i}:00 AM` : i === 12 ? "12:00 PM (noon)" : `${i - 12}:00 PM`;
  return { value: i, label: `${h}:00 UTC — ${label}` };
});

export default function UserSettingsPage() {
  const role = useRole();
  const router = useRouter();

  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (role === null) { router.replace("/login"); return; }
    if (role === undefined) return;
    fetch("/api/user-prefs")
      .then(r => r.json())
      .then(setPrefs)
      .catch(() => setError("Could not load preferences."));
  }, [role, router]);

  async function save() {
    if (!prefs) return;
    setSaving(true); setError(null); setSaved(false);
    const res = await fetch("/api/user-prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    });
    setSaving(false);
    if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 3000); }
    else setError("Save failed — please try again.");
  }

  function set<K extends keyof Prefs, F extends keyof Prefs[K]>(section: K, field: F, value: Prefs[K][F]) {
    setPrefs(p => p ? { ...p, [section]: { ...p[section], [field]: value } } : p);
  }

  if (role === undefined || !prefs) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: T.muted, fontSize: "14px" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "Inter, sans-serif" }}>
      <PageHeader
        title="My Settings"
        whatItDoes="Email digest timing, newsletter opt-in, and broker connection link."
        whatToLookFor={["Toggle the daily risk email on or off and pick your preferred send hour.", "Opt in or out of the newsletter.", "Connect your own broker account for personal risk analytics."]}
      />
      <div style={{ maxWidth: "600px", margin: "0 auto", padding: "32px 16px", display: "flex", flexDirection: "column", gap: "24px" }}>

        {/* Daily Risk Email */}
        <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "16px" }}>
            Daily Risk Email
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 500 }}>Risk digest email</div>
              <div style={{ fontSize: "13px", color: T.muted, marginTop: "2px" }}>
                Daily email with your portfolio risk summary
              </div>
            </div>
            <button
              onClick={() => set("riskEmail", "enabled", !prefs.riskEmail.enabled)}
              style={{
                width: "48px", height: "26px", borderRadius: "13px", border: "none", cursor: "pointer",
                background: prefs.riskEmail.enabled ? T.accent : T.border,
                position: "relative", transition: "background 0.2s",
              }}
            >
              <div style={{
                position: "absolute", top: "3px", left: prefs.riskEmail.enabled ? "25px" : "3px",
                width: "20px", height: "20px", borderRadius: "50%", background: T.text,
                transition: "left 0.2s",
              }} />
            </button>
          </div>
          {prefs.riskEmail.enabled && (
            <div>
              <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Send time</label>
              <select
                value={prefs.riskEmail.sendHourUtc}
                onChange={e => set("riskEmail", "sendHourUtc", Number(e.target.value))}
                style={{
                  width: "100%", background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: "8px", color: T.text, padding: "8px 12px", fontSize: "13px",
                }}
              >
                {UTC_HOURS.map(h => (
                  <option key={h.value} value={h.value}>{h.label}</option>
                ))}
              </select>
            </div>
          )}
          {prefs.riskEmail.lastSentAt && (
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "12px" }}>
              Last sent: {new Date(prefs.riskEmail.lastSentAt).toLocaleString()}
            </div>
          )}
        </section>

        {/* Newsletter */}
        <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "16px" }}>
            Newsletter
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 500 }}>Kairos updates</div>
              <div style={{ fontSize: "13px", color: T.muted, marginTop: "2px" }}>
                Occasional emails about new features and improvements
              </div>
            </div>
            <button
              onClick={() => set("newsletter", "optedIn", !prefs.newsletter.optedIn)}
              style={{
                width: "48px", height: "26px", borderRadius: "13px", border: "none", cursor: "pointer",
                background: prefs.newsletter.optedIn ? T.accent : T.border,
                position: "relative", transition: "background 0.2s",
              }}
            >
              <div style={{
                position: "absolute", top: "3px", left: prefs.newsletter.optedIn ? "25px" : "3px",
                width: "20px", height: "20px", borderRadius: "50%", background: T.text,
                transition: "left 0.2s",
              }} />
            </button>
          </div>
        </section>

        {/* Broker Connections */}
        <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "16px" }}>
            Connected Brokers
          </div>
          <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "16px" }}>
            Connect your own Zerodha or Robinhood account to see personalized risk analytics.
          </div>
          <button
            onClick={() => router.push("/dashboard/connections")}
            style={{
              background: T.accent, color: T.text, border: "none", borderRadius: "8px",
              padding: "10px 20px", fontSize: "14px", fontWeight: 500, cursor: "pointer",
            }}
          >
            Manage connections →
          </button>
        </section>

        {/* Save */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            onClick={save}
            disabled={saving}
            style={{
              background: T.accent, color: T.text, border: "none", borderRadius: "8px",
              padding: "12px 28px", fontSize: "14px", fontWeight: 600, cursor: saving ? "not-allowed" : "pointer",
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save preferences"}
          </button>
          {saved && <span style={{ fontSize: "13px", color: T.green }}>Saved ✓</span>}
          {error && <span style={{ fontSize: "13px", color: T.red }}>{error}</span>}
        </div>

      </div>
    </div>
  );
}
