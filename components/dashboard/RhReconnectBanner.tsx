"use client";
import { useEffect, useState } from "react";

// Reconnect banner for pages backed by the Robinhood live-account snapshot
// (Live Portfolio, Portfolio Risk). Reads the same vault-only token-age check as
// the Settings badge (GET /api/robinhood-mcp/status → checkRobinhoodTokenHealth,
// which also attempts a CAS refresh). Renders ONLY on a genuine dead-token state
// (`stale`), so a routine short-TTL rollover that the check silently refreshes
// shows nothing. Keeps the "is my live data real?" answer next to the data
// itself instead of only in Settings / System Health.
type RhStatus = { connected: boolean; stale?: boolean; expires_at?: string | null; has_refresh?: boolean };

export default function RhReconnectBanner() {
  const [st, setSt] = useState<RhStatus | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/robinhood-mcp/status")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (alive && d) setSt(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Only warn on a genuinely-dead connection: present-but-stale (refresh failed)
  // is the reconnect-required state. `connected:false` = never connected → no
  // stale-data claim to correct, so we stay quiet.
  if (!st || !(st.connected && st.stale)) return null;

  return (
    <div
      role="alert"
      style={{
        display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap",
        background: "#3B0000", border: "1px solid #F87171", borderRadius: "10px",
        padding: "clamp(10px, 3vw, 14px) clamp(12px, 3vw, 18px)", marginBottom: "16px",
      }}
    >
      <span style={{ fontSize: "16px", lineHeight: 1 }}>⚠️</span>
      <div style={{ flex: "1 1 260px", minWidth: 0 }}>
        <div style={{ fontSize: "13px", fontWeight: 700, color: "#FCA5A5", marginBottom: "2px" }}>
          Robinhood connection expired — data below may be stale
        </div>
        <div style={{ fontSize: "12px", color: "#F8B4B4" }}>
          The Robinhood token could not be refreshed{st.expires_at ? ` (expired ${new Date(st.expires_at).toLocaleString()})` : ""}
          {st.has_refresh === false ? " — no refresh token stored" : ""}. Live holdings, balances and per-holding risk stopped
          updating until you reconnect.
        </div>
      </div>
      <a
        href="/dashboard/settings"
        style={{
          flex: "0 0 auto", background: "#F87171", color: "#1A0000", textDecoration: "none",
          borderRadius: "8px", padding: "8px 16px", fontSize: "13px", fontWeight: 700,
        }}
      >
        Reconnect Robinhood
      </a>
    </div>
  );
}
