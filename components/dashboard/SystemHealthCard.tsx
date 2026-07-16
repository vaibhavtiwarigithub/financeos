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

function ActionButton({ label, state, okLabel, onClick, color }: {
  label: string; state?: "pending" | "ok" | "err"; okLabel: string;
  onClick: () => void; color: string;
}) {
  const busy = state === "pending";
  const done = state === "ok";
  const failed = state === "err";
  return (
    <button
      onClick={onClick}
      disabled={busy || done}
      style={{
        background: "transparent",
        border: `1px solid ${failed ? T.red : done ? T.green : color}`,
        borderRadius: "5px",
        color: failed ? T.red : done ? T.green : color,
        padding: "3px 10px", fontSize: "10px", fontWeight: 700,
        cursor: busy || done ? "default" : "pointer",
        letterSpacing: "0.04em",
      }}
    >
      {busy ? "…" : done ? okLabel : failed ? "Failed" : label}
    </button>
  );
}

export default function SystemHealthCard() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [triage, setTriage] = useState<{ content: string; model?: string; open_alerts?: number; ts?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState<Record<string, "pending" | "ok" | "err">>({});

  useEffect(() => {
    fetch("/api/alerts")
      .then(r => { if (!r.ok) throw new Error("health read failed"); return r.json(); })
      .then(d => setAlerts(Array.isArray(d.alerts) ? d.alerts : []))
      .catch(() => setLoadError(true))
      .finally(() => setLoaded(true));
    fetch("/api/agents/health-triage")
      .then(r => { if (!r.ok) throw new Error("triage read failed"); return r.json(); })
      .then(d => setTriage(d.triage ?? null))
      .catch(() => {});
  }, []);

  async function runTriage() {
    setRunning(true);
    try {
      const r = await fetch("/api/agents/health-triage", { method: "POST" });
      const d = await r.json();
      if (d.ok) setTriage({ content: d.content, model: d.model, open_alerts: d.open_alerts, ts: d.ts });
    } catch { /* best-effort */ } finally { setRunning(false); }
  }

  async function applyFix(action: string, alert: Alert) {
    setApplying(prev => ({ ...prev, [alert.id]: "pending" }));
    try {
      const r = await fetch("/api/health/apply-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, alert_id: alert.id, issue_key: alert.issue_key }),
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setApplying(prev => ({ ...prev, [alert.id]: "ok" }));
        if (action === "resolve_alert") {
          setAlerts(prev => prev.filter(a => a.id !== alert.id));
        } else {
          setTimeout(() => setApplying(prev => { const n = { ...prev }; delete n[alert.id]; return n; }), 2000);
        }
      } else {
        setApplying(prev => ({ ...prev, [alert.id]: "err" }));
        setTimeout(() => setApplying(prev => { const n = { ...prev }; delete n[alert.id]; return n; }), 3000);
      }
    } catch {
      setApplying(prev => ({ ...prev, [alert.id]: "err" }));
      setTimeout(() => setApplying(prev => { const n = { ...prev }; delete n[alert.id]; return n; }), 3000);
    }
  }

  if (!loaded) return null;

  if (loadError) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.yellow}66`, borderRadius: "12px", padding: "16px 18px", marginBottom: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "9px" }}>
          <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: T.yellow }} />
          <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>System Health</span>
          <span style={{ fontSize: "12px", fontWeight: 600, color: T.yellow, marginLeft: "auto" }}>Status unavailable</span>
        </div>
        <div style={{ fontSize: "12px", color: T.textSub, marginTop: "8px" }}>The alert feed could not be read. This is not treated as a healthy state; reload or inspect Intelligence.</div>
      </div>
    );
  }

  const sorted = [...alerts].sort(
    (a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0)
      || (a.created_at < b.created_at ? 1 : -1),
  );
  const worst = sorted[0]?.severity;
  const nCrit = alerts.filter(a => a.severity === "critical").length;
  const clean = alerts.length === 0;

  const headColor = clean ? T.green : SEV_COLOR[worst] ?? T.blue;
  const newestAlertMs = Math.max(0, ...alerts.map((alert) => Date.parse(alert.created_at) || 0));
  const triageMs = Date.parse(triage?.ts ?? "") || 0;
  const triageStale = !!triage && (triage.open_alerts !== alerts.length || triageMs < newestAlertMs);

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
                    <div style={{ display: "flex", gap: "6px", marginTop: "8px" }}>
                      {a.category === "cron" && a.issue_key?.startsWith("cron:") && (
                        <ActionButton
                          label="Retry"
                          state={applying[a.id]}
                          okLabel="Queued"
                          onClick={() => applyFix("retry_cron", a)}
                          color={T.blue}
                        />
                      )}
                      {(a.severity === "info" || a.severity === "warn") && (
                        <ActionButton
                          label="Resolve"
                          state={applying[a.id]}
                          okLabel="Resolved"
                          onClick={() => applyFix("resolve_alert", a)}
                          color={T.green}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Deterministic triage snapshot. Raw open alerts above remain authoritative. */}
      <div style={{ marginTop: clean ? "12px" : "14px", borderTop: `1px solid ${T.border}`, paddingTop: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>Health Triage</span>
          <button onClick={runTriage} disabled={running}
            style={{ marginLeft: "auto", background: "transparent", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.textSub, padding: "4px 12px", fontSize: "11px", fontWeight: 600, cursor: running ? "default" : "pointer" }}>
            {running ? "Running…" : "Run triage"}
          </button>
        </div>
        {triageStale && (
          <div style={{ fontSize: "12px", color: T.yellow, lineHeight: 1.5, marginTop: "8px" }}>
            Triage snapshot is older than the current alert feed. Run triage to reconcile it.
          </div>
        )}
        {triage?.content && !triageStale && (
          <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.6, whiteSpace: "pre-wrap", marginTop: "8px" }}>
            {triage.content}
            {triage.model && <div style={{ fontSize: "10px", color: T.muted, marginTop: "6px" }}>— {triage.model} · {triage.ts ? new Date(triage.ts).toLocaleString() : "latest snapshot"}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
