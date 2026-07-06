"use client";
import { useState, useEffect } from "react";

const T = {
  card: "#1A1D27", border: "#252836", surface: "#13151C",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

type GoalResp = {
  goal: null | {
    id: number; market: string; target_return_pct: number; horizon_days: number; start_nav: number; start_date: string; status: string;
  };
  currentNav?: number; progressPct?: number; requiredDailyPct?: number; realizedDailyPct?: number | null;
  feasibility?: string; onTrack?: boolean | null; daysLeft?: number; daysElapsed?: number;
};

// Goal tracker — a MEASURED dashboard only. Never read by any agent route
// (see Decision 34: return targets are never agent parameters).
export default function GoalCard() {
  const [data, setData] = useState<GoalResp | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [targetPct, setTargetPct] = useState(10);
  const [horizonDays, setHorizonDays] = useState(30);
  const [saving, setSaving] = useState(false);

  function load() {
    fetch("/api/goals?market=us").then(r => r.json()).then(setData).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function setGoal() {
    setSaving(true);
    try {
      await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market: "us", target_return_pct: targetPct, horizon_days: horizonDays }),
      });
      setShowForm(false);
      load();
    } finally { setSaving(false); }
  }

  if (!data) return null;

  if (!data.goal || showForm) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 18px", marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase", marginBottom: "10px" }}>Goal</div>
        <div style={{ display: "flex", gap: "10px", alignItems: "center", flexWrap: "wrap" as const }}>
          <label style={{ fontSize: "12px", color: T.textSub }}>Target</label>
          <input type="number" value={targetPct} min={1} max={500} onChange={e => setTargetPct(parseFloat(e.target.value) || 0)}
            style={{ width: "70px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "6px 8px", fontSize: "12px" }} />
          <span style={{ fontSize: "12px", color: T.textSub }}>% in</span>
          <input type="number" value={horizonDays} min={1} max={3650} onChange={e => setHorizonDays(parseInt(e.target.value) || 0)}
            style={{ width: "70px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, padding: "6px 8px", fontSize: "12px" }} />
          <span style={{ fontSize: "12px", color: T.textSub }}>days</span>
          <button onClick={setGoal} disabled={saving} style={{ background: T.accent, border: "none", borderRadius: "6px", color: "#fff", padding: "6px 16px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
            {saving ? "..." : "Set goal"}
          </button>
          {data.goal && <button onClick={() => setShowForm(false)} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.textSub, padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>Cancel</button>}
        </div>
      </div>
    );
  }

  const g = data.goal;
  const progress = data.progressPct ?? 0;
  const target = Number(g.target_return_pct);
  const pctOfTarget = Math.max(0, Math.min(100, (progress / target) * 100));
  // onTrack is null on the goal's creation day (0 elapsed days) — not enough
  // history yet to claim on/off track either way; show neutral, not a fake green.
  const statusColor = g.status === "achieved" ? T.green : g.status === "missed" ? T.red
    : data.onTrack == null ? T.textSub : data.onTrack ? T.green : T.amber;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 18px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const }}>
          Goal · {target}% in {g.horizon_days}d
        </div>
        <button onClick={() => setShowForm(true)} style={{ background: "transparent", border: "none", color: T.textSub, fontSize: "11px", cursor: "pointer", textDecoration: "underline" }}>Change</button>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "6px" }}>
        <span style={{ fontSize: "20px", fontWeight: 700, color: statusColor }}>{progress >= 0 ? "+" : ""}{progress.toFixed(1)}%</span>
        <span style={{ fontSize: "11px", color: T.muted }}>{data.daysLeft ?? 0}d left · {g.status}</span>
      </div>
      <div style={{ background: T.surface, borderRadius: "6px", height: "6px", overflow: "hidden", marginBottom: "8px" }}>
        <div style={{ width: `${pctOfTarget}%`, height: "100%", background: statusColor, transition: "width 0.3s" }} />
      </div>
      <div style={{ fontSize: "11px", color: T.textSub, lineHeight: 1.5 }}>{data.feasibility}</div>
    </div>
  );
}
