"use client";
import { useState, useEffect } from "react";

// Persistent System Health card. Reads OPEN agent_alerts (the System Health
// funnel — model deprecations, AV budget, broker-token expiry, kill-switch
// trips, unreconciled orders, cron failures) and keeps them in the user's face
// on the dashboard home until they resolve. Green/quiet when clean.

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", green: "#34D399", red: "#F87171", yellow: "#FBBF24", blue: "#60A5FA",
};

type Alert = {
  id: string;
  severity: "info" | "warn" | "error" | "critical" | "success";
  category: string;
  title: string;
  detail?: string;
  issue_key?: string;
  created_at: string;
};

const SEV_RANK: Record<string, number> = { critical: 4, error: 3, warn: 2, info: 1, success: 0 };
const SEV_COLOR: Record<string, string> = {
  critical: T.red, error: T.red, warn: T.yellow, info: T.blue, success: T.green,
};
const SEV_LABEL: Record<string, string> = {
  critical: "CRITICAL", error: "ERROR", warn: "WARN", info: "INFO", success: "OK",
};

// A deep link / hint per category so the card is actionable, not just informational.
function fixHint(a: Alert): { href?: string; label: string } {
  const cat = a.category;
  if (cat === "models") return { href: "/dashboard/agents", label: "Reassign in Agents → Model Config" };
  if (cat === "broker") return { href: "/dashboard/settings", label: "Reconnect in Settings" };
  if (cat === "trading") return { href: "/dashboard/settings", label: "Review in Settings → Trading" };
  if (cat === "data") return { label: "Resolves at the next data-quota reset" };
  if (cat === "cron") return { href: "/dashboard/intelligence", label: "See Intelligence → runs" };
  return { label: "" };
}

export default function SystemHealthCard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/alerts")
      .then(r => r.json())
      .then(d => setAlerts(Array.isArray(d.alerts) ? d.alerts : []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  if (!loaded) return null;

  const sorted = [...alerts].sort(
    (a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0)
      || (a.created_at < b.created_at ? 1 : -1),
  );
  const worst = sorted[0]?.severity;
  const nCrit = alerts.filter(a => a.severity === "critical").length;
  const clean = alerts.length === 0;

  const headColor = clean ? T.green : SEV_COLOR[worst] ?? T.blue;

  return (
    <div style={{ background: T.card, border: `1px solid ${clean ? T.border : headColor + "66"}`, borderRadius: "12px", padding: "16px 18px", marginBottom: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: clean ? 0 : "12px" }}>
        <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: headColor, flexShrink: 0, boxShadow: clean ? "none" : `0 0 8px ${headColor}` }} />
        <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          System Health
        </span>
        <span style={{ fontSize: "12px", fontWeight: 600, color: clean ? T.green : headColor, marginLeft: "auto" }}>
          {clean ? "All systems normal" : `${alerts.length} open issue${alerts.length !== 1 ? "s" : ""}${nCrit ? ` · ${nCrit} critical` : ""}`}
        </span>
      </div>

      {!clean && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {sorted.map(a => {
            const color = SEV_COLOR[a.severity] ?? T.blue;
            const isOpen = expanded === a.id;
            const hint = fixHint(a);
            return (
              <div key={a.id} style={{ borderLeft: `2px solid ${color}`, paddingLeft: "10px" }}>
                <div
                  onClick={() => a.detail && setExpanded(isOpen ? null : a.id)}
                  style={{ display: "flex", alignItems: "center", gap: "8px", cursor: a.detail ? "pointer" : "default" }}
                >
                  <span style={{ fontSize: "9px", fontWeight: 800, color, letterSpacing: "0.05em", flexShrink: 0 }}>
                    {SEV_LABEL[a.severity] ?? a.severity.toUpperCase()}
                  </span>
                  <span style={{ fontSize: "13px", color: T.text, fontWeight: 500 }}>{a.title}</span>
                  {a.detail && (
                    <span style={{ fontSize: "9px", color: T.muted, marginLeft: "auto", flexShrink: 0 }}>{isOpen ? "▲" : "▼"}</span>
                  )}
                </div>
                {isOpen && a.detail && (
                  <div style={{ fontSize: "12px", color: T.textSub, marginTop: "5px", lineHeight: 1.5 }}>
                    {a.detail}
                    {hint.label && (
                      <div style={{ marginTop: "6px" }}>
                        {hint.href
                          ? <a href={hint.href} style={{ fontSize: "11px", color: T.blue, textDecoration: "none" }}>→ {hint.label}</a>
                          : <span style={{ fontSize: "11px", color: T.muted }}>{hint.label}</span>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
