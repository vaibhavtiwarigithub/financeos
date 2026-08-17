"use client";
import { useState, useEffect } from "react";
import { useMarket } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", red: "#F87171", amber: "#FBBF24", blue: "#60A5FA",
};

type Row = {
  date: string;
  market: string;
  runs: number;
  queue: number;
  holdings: number;
  candidates: number;
  deferred: number;
  budget_pressure_pct: number;
  signals: number;
  discovery: number;
  watchlist: number;
  discovery_gap: "ok" | "low" | "zero";
};

function PressureBar({ pct }: { pct: number }) {
  const color = pct >= 30 ? T.red : pct >= 15 ? T.amber : T.green;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
      <div style={{ width: "60px", height: "5px", background: T.border, borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: "11px", color, fontVariantNumeric: "tabular-nums" }}>{pct}%</span>
    </div>
  );
}

function DiscoveryBadge({ gap, count }: { gap: "ok" | "low" | "zero"; count: number }) {
  const cfg = {
    ok:   { label: `✓ ${count}`, color: T.green },
    low:  { label: `⚡ ${count}`, color: T.amber },
    zero: { label: "⚠️ 0",       color: T.red },
  }[gap];
  return <span style={{ fontSize: "12px", fontWeight: 700, color: cfg.color }}>{cfg.label}</span>;
}

// Mini sparkline for discovery counts across 30 days.
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const W = 180, H = 28;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W;
    const y = H - (v / max) * H;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={W} height={H} style={{ display: "block" }}>
      <polyline points={pts} fill="none" stroke={T.accent} strokeWidth="1.5" strokeLinejoin="round" />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={(i / (values.length - 1)) * W}
          cy={H - (v / max) * H}
          r="2"
          fill={v === 0 ? T.red : T.accent}
        />
      ))}
    </svg>
  );
}

export default function PipelineHealthTab() {
  const { market } = useMarket();
  const [data, setData] = useState<{ rows: Row[] } | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    setData(null);
    fetch(`/api/agents/research/pipeline-health?market=${market}&days=${days}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [market, days]);

  const rows: Row[] = data?.rows ?? [];

  // Discovery sparkline: oldest → newest
  const sparkValues = [...rows].reverse().map(r => r.discovery);

  // Totals for summary cards
  const totalSignals = rows.reduce((a, r) => a + r.signals, 0);
  const totalDiscovery = rows.reduce((a, r) => a + r.discovery, 0);
  const zeroDiscoveryDays = rows.filter(r => r.discovery_gap === "zero" && r.runs > 0).length;
  const avgPressure = rows.length ? Math.round(rows.reduce((a, r) => a + r.budget_pressure_pct, 0) / rows.length) : 0;

  const Stat = ({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", minWidth: "130px" }}>
      <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: color ?? T.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ paddingBottom: "32px" }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
        <span style={{ fontSize: "12px", color: T.muted }}>Window:</span>
        {[14, 30, 60, 90].map(d => (
          <button key={d} onClick={() => setDays(d)} style={{
            padding: "5px 12px", borderRadius: "6px", cursor: "pointer", fontSize: "12px", fontWeight: 600,
            background: days === d ? T.accentBg : T.surface,
            border: `1px solid ${days === d ? T.accent : T.border}`,
            color: days === d ? T.accent : T.textSub,
          }}>
            {d}d
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "24px" }}>
        <Stat label="Signals generated" value={totalSignals} sub={`last ${days} days`} />
        <Stat label="Discovery scored" value={totalDiscovery} sub="screener→ledger" color={totalDiscovery === 0 ? T.red : T.green} />
        <Stat label="Zero-discovery days" value={zeroDiscoveryDays} sub="of active days"
          color={zeroDiscoveryDays > 3 ? T.red : zeroDiscoveryDays > 0 ? T.amber : T.green} />
        <Stat label="Avg budget pressure" value={`${avgPressure}%`} sub="first-run deferred/queue"
          color={avgPressure >= 30 ? T.red : avgPressure >= 15 ? T.amber : T.green} />
      </div>

      {/* Discovery sparkline */}
      {sparkValues.length > 1 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", marginBottom: "20px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "10px" }}>
            Discovery trend — screener obs per day (red dot = zero)
          </div>
          <Sparkline values={sparkValues} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: "4px" }}>
            <span style={{ fontSize: "10px", color: T.muted }}>{rows[rows.length - 1]?.date ?? ""}</span>
            <span style={{ fontSize: "10px", color: T.muted }}>{rows[0]?.date ?? ""}</span>
          </div>
        </div>
      )}

      {/* Legend */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "11px", color: T.muted, lineHeight: 1.7 }}>
        <strong style={{ color: T.textSub }}>Column guide</strong> —{" "}
        <strong>Queue</strong>: total symbols entering the pipeline that day.{" "}
        <strong>Holdings</strong>: existing positions re-scored for HOLD/SELL signals.{" "}
        <strong>Watchlist</strong>: on-watch candidates (not yet held).{" "}
        <strong>Discovery</strong>: screener/basket candidates that reached the evidence ledger — the new-name pipeline inflow.{" "}
        <strong>Deferred</strong>: symbols the wall-clock budget did not reach in the first (main) run.{" "}
        <strong>Budget %</strong>: deferred ÷ queue — how full the run was; &gt;30% means chronic pressure.{" "}
        <strong>Discovery gap</strong>: ✓ ≥5 screener obs | ⚡ 1–4 | ⚠️ zero — zero means no new names entered the ledger that day.
      </div>

      {/* Table */}
      {loading && <div style={{ color: T.muted, fontSize: "13px" }}>Loading…</div>}
      {!loading && rows.length === 0 && <div style={{ color: T.muted, fontSize: "13px" }}>No research runs in window.</div>}
      {!loading && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Date", "Runs", "Queue", "Holdings", "Watchlist", "Discovery", "Deferred", "Budget %", "Signals", "Discovery gap"].map(h => (
                  <th key={h} style={{ padding: "8px 12px", textAlign: "left", color: T.muted, fontWeight: 600, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const isWeekend = (() => {
                  const d = new Date(row.date + "T12:00:00Z");
                  const day = d.getUTCDay();
                  return day === 0 || day === 6;
                })();
                const dimmed = row.runs === 0;
                return (
                  <tr key={row.date} style={{
                    borderBottom: `1px solid ${T.border}`,
                    background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                    opacity: dimmed ? 0.45 : 1,
                  }}>
                    <td style={{ padding: "9px 12px", color: T.text, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                      {row.date}{isWeekend ? <span style={{ color: T.muted, marginLeft: "4px", fontSize: "10px" }}>wknd</span> : null}
                    </td>
                    <td style={{ padding: "9px 12px", color: T.textSub, textAlign: "center" }}>{row.runs || "—"}</td>
                    <td style={{ padding: "9px 12px", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{row.queue || "—"}</td>
                    <td style={{ padding: "9px 12px", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{row.holdings || "—"}</td>
                    <td style={{ padding: "9px 12px", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{row.watchlist || "—"}</td>
                    <td style={{ padding: "9px 12px", fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: row.discovery === 0 && row.runs > 0 ? T.red : T.textSub }}>
                        {row.discovery || (row.runs > 0 ? "0" : "—")}
                      </span>
                    </td>
                    <td style={{ padding: "9px 12px", color: row.deferred > 0 ? T.amber : T.muted, fontVariantNumeric: "tabular-nums" }}>
                      {row.deferred > 0 ? row.deferred : "—"}
                    </td>
                    <td style={{ padding: "9px 12px" }}>
                      {row.runs > 0 ? <PressureBar pct={row.budget_pressure_pct} /> : <span style={{ color: T.muted }}>—</span>}
                    </td>
                    <td style={{ padding: "9px 12px", color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{row.signals || "—"}</td>
                    <td style={{ padding: "9px 12px" }}>
                      {row.runs > 0 ? <DiscoveryBadge gap={row.discovery_gap} count={row.discovery} /> : <span style={{ color: T.muted }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
