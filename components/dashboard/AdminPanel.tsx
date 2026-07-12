"use client";
import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

interface UserRow {
  id: string; email: string; full_name: string | null;
  role: string; subscription_tier: string;
  xp: number; analysis_count: number; created_at: string;
}

export default function AdminPanel() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState<{ totalUsers: number; proUsers: number; eliteUsers: number; totalCost: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  // DB Cleanup
  const [cleanupPreview, setCleanupPreview] = useState<Record<string, number> | null>(null);
  const [cleanupTotal, setCleanupTotal] = useState<number>(0);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<{ totalDeleted: number; results: Record<string, number>; ranAt: string } | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    try {
      const r = await fetch("/api/agents/db-cleanup");
      const d = await r.json();
      if (d.preview) {
        setCleanupPreview(d.preview);
        setCleanupTotal(d.totalPreview ?? 0);
      }
    } catch { /* silent */ }
  }, []);

  const runCleanup = async () => {
    setCleanupRunning(true);
    setCleanupError(null);
    setCleanupResult(null);
    try {
      const r = await fetch("/api/agents/db-cleanup", { method: "POST" });
      const d = await r.json();
      if (!r.ok) { setCleanupError(d.error ?? "Cleanup failed"); return; }
      setCleanupResult(d);
      setCleanupPreview(null);
      setCleanupTotal(0);
    } catch (e: any) {
      setCleanupError(e?.message ?? "Network error");
    } finally {
      setCleanupRunning(false);
    }
  };

  useEffect(() => {
    Promise.all([
      fetch("/api/admin?action=users").then(r => r.json()),
      fetch("/api/admin?action=stats").then(r => r.json()),
    ]).then(([u, s]) => {
      setUsers(u.users ?? []);
      setStats(s);
      setLoading(false);
    });
  }, []);

  async function updateUser(userId: string, field: "role" | "tier", value: string) {
    setUpdating(userId);
    await fetch("/api/admin", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, [field]: value }),
    });
    setUsers(prev => prev.map(u => u.id === userId ? { ...u, [field === "tier" ? "subscription_tier" : "role"]: value } : u));
    setUpdating(null);
  }

  const card = { background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" };
  const sel: React.CSSProperties = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "4px 8px", fontSize: "12px", cursor: "pointer" };

  return (
    <div style={{ padding: "28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
        <div style={{ fontSize: "20px", fontWeight: 600 }}>Admin Dashboard</div>
        <Link href="/dashboard/admin/vault"
          style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#252836", border: "1px solid #363a4d", borderRadius: "8px", padding: "7px 14px", fontSize: "13px", fontWeight: 600, color: T.accent, textDecoration: "none" }}>
          🔐 API Vault
        </Link>
      </div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: "24px" }}>Manage users, roles, and subscriptions</div>

      {/* Stats */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "24px" }}>
          {[
            { label: "Total Users", value: stats.totalUsers, color: T.accent },
            { label: "Pro Users", value: stats.proUsers, color: T.accent },
            { label: "Elite Users", value: stats.eliteUsers, color: T.yellow },
            { label: "30d AI Cost", value: "$" + (stats.totalCost ?? 0).toFixed(2), color: T.green },
          ].map(s => (
            <div key={s.label} style={card}>
              <div style={{ fontSize: "26px", fontWeight: 700, color: s.color, fontFamily: "'JetBrains Mono', monospace" }}>{s.value}</div>
              <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* DB Cleanup */}
      <div style={{ ...card, marginBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 600 }}>Database Cleanup</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>Auto-runs 1st of every month. Safe tables only — ledgers never touched.</div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={loadPreview}
              disabled={cleanupRunning}
              style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "7px 14px", fontSize: "13px", color: T.textSub, cursor: "pointer" }}
            >
              Preview
            </button>
            <button
              onClick={runCleanup}
              disabled={cleanupRunning}
              style={{ background: cleanupRunning ? T.surface : "#1a1d27", border: `1px solid ${T.border}`, borderRadius: "8px", padding: "7px 14px", fontSize: "13px", fontWeight: 600, color: cleanupRunning ? T.muted : T.red, cursor: cleanupRunning ? "not-allowed" : "pointer" }}
            >
              {cleanupRunning ? "Running…" : "Run Now"}
            </button>
          </div>
        </div>

        {cleanupError && (
          <div style={{ background: T.red + "18", border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "10px 14px", fontSize: "13px", color: T.red, marginBottom: "12px" }}>
            {cleanupError}
          </div>
        )}

        {cleanupResult && (
          <div style={{ background: T.green + "12", border: `1px solid ${T.green}33`, borderRadius: "8px", padding: "12px 14px", marginBottom: "12px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: T.green, marginBottom: "8px" }}>
              Done — {cleanupResult.totalDeleted.toLocaleString()} rows deleted · {new Date(cleanupResult.ranAt).toLocaleString()}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px" }}>
              {Object.entries(cleanupResult.results).map(([label, count]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: count < 0 ? T.red : count === 0 ? T.muted : T.text }}>
                  <span>{label}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", marginLeft: "12px" }}>
                    {count < 0 ? "err" : count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {cleanupPreview && !cleanupResult && (
          <div style={{ background: T.yellow + "10", border: `1px solid ${T.yellow}33`, borderRadius: "8px", padding: "12px 14px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: T.yellow, marginBottom: "8px" }}>
              Preview — {cleanupTotal.toLocaleString()} rows eligible for deletion
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 24px" }}>
              {Object.entries(cleanupPreview).map(([label, count]) => (
                <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: count === 0 ? T.muted : T.text }}>
                  <span>{label}</span>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", marginLeft: "12px" }}>
                    {count < 0 ? "err" : count.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!cleanupPreview && !cleanupResult && !cleanupRunning && (
          <div style={{ fontSize: "12px", color: T.muted }}>
            Tables pruned: llm_call_log (&gt;90d) · agent_runs (&gt;60d) · briefings (&gt;90d) · signal_score_history (&gt;180d) · macro_signals (&gt;90d) · rag_traces (&gt;90d) · edge_signals (&gt;180d) · doc_chunks (&gt;180d) · india_screen_cache (&gt;7d) · resolved alerts (&gt;30d) · and more.
            Never touches: paper_trades · paper_order_events · decision_observations · broker_orders · strategy_evaluations.
          </div>
        )}
      </div>

      {/* Users table */}
      <div style={card}>
        <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "16px" }}>All Users</div>
        {loading ? (
          <div style={{ color: T.muted, textAlign: "center", padding: "40px" }}>Loading...</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["User", "Role", "Tier", "Status", "XP", "Analyses", "Joined"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontSize: "11px", fontWeight: 500, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} style={{ borderBottom: `1px solid ${T.border}44` }}>
                    <td style={{ padding: "10px" }}>
                      <div style={{ fontWeight: 500 }}>{u.full_name || u.email.split("@")[0]}</div>
                      <div style={{ fontSize: "11px", color: T.muted }}>{u.email}</div>
                    </td>
                    <td style={{ padding: "10px" }}>
                      <select value={u.role} onChange={e => updateUser(u.id, "role", e.target.value)} disabled={updating === u.id} style={sel}>
                        <option value="user">user</option>
                        <option value="admin">admin</option>
                        <option value="superadmin">superadmin</option>
                      </select>
                    </td>
                    <td style={{ padding: "10px" }}>
                      <select value={u.subscription_tier} onChange={e => updateUser(u.id, "tier", e.target.value)} disabled={updating === u.id} style={sel}>
                        <option value="free">free</option>
                        <option value="pro">pro</option>
                        <option value="elite">elite</option>
                      </select>
                    </td>
                    <td style={{ padding: "10px" }}>
                      {/* No billing subsystem wired up yet — subscription_status
                          doesn't exist on profiles. Show a neutral placeholder
                          instead of a fake "active" status. */}
                      <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: T.muted + "22", color: T.muted }}>
                        n/a
                      </span>
                    </td>
                    <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace", color: T.accent }}>{u.xp}</td>
                    <td style={{ padding: "10px", fontFamily: "'JetBrains Mono', monospace" }}>{u.analysis_count}</td>
                    <td style={{ padding: "10px", color: T.muted, fontSize: "12px" }}>{new Date(u.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
