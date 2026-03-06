"use client";
import { useState, useEffect } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

interface UserRow {
  id: string; email: string; full_name: string | null;
  role: string; subscription_tier: string; subscription_status: string;
  xp: number; analysis_count: number; created_at: string;
}

export default function AdminPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [stats, setStats] = useState<{ totalUsers: number; proUsers: number; eliteUsers: number; totalCost: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

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
      <div style={{ fontSize: "20px", fontWeight: 600, marginBottom: "6px" }}>Admin Dashboard</div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: "24px" }}>Manage users, roles, and subscriptions</div>

      {/* Stats */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "24px" }}>
          {[
            { label: "Total Users", value: stats.totalUsers, color: T.accent },
            { label: "Pro Users", value: stats.proUsers, color: T.blue },
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
                      <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: u.subscription_status === "active" ? T.green + "22" : T.red + "22", color: u.subscription_status === "active" ? T.green : T.red }}>
                        {u.subscription_status}
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
