"use client";
import { useState, useEffect } from "react";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", surface: "#13151C",
};

const PERIOD_OPTIONS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
  { label: "1Y", days: 365 },
];

interface SectorRow {
  symbol: string;
  name: string;
  returnPct: number | null;
  latestClose?: number;
  candles: number;
}

export default function SectorPerformanceChart() {
  const [period, setPeriod] = useState(PERIOD_OPTIONS[2]);
  const [sectors, setSectors] = useState<SectorRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/charts/sector-returns?days=${period.days}`)
      .then(r => r.json())
      .then(d => {
        setSectors(d.sectors ?? []);
        setStale(d.stale ?? false);
      })
      .catch(() => setSectors([]))
      .finally(() => setLoading(false));
  }, [period.days]);

  const loaded = sectors.filter(s => s.returnPct !== null) as (SectorRow & { returnPct: number })[];
  const sorted = [...loaded].sort((a, b) => b.returnPct - a.returnPct);
  const maxAbs = Math.max(...sorted.map(s => Math.abs(s.returnPct)), 1);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "2px" }}>
            Sector Performance
          </div>
          <div style={{ fontSize: "13px", color: T.textSub }}>SPDR Sector ETFs · {period.label} return</div>
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {PERIOD_OPTIONS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)} style={{
              padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
              cursor: "pointer", border: "none",
              background: period.label === p.label ? T.accent : T.surface,
              color: period.label === p.label ? "#fff" : T.muted,
            }}>{p.label}</button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {Array.from({ length: 11 }).map((_, i) => (
            <div key={i} style={{ height: "34px", background: T.surface, borderRadius: "6px", opacity: 0.4, animation: "pulse 1.4s ease-in-out infinite" }} />
          ))}
          <style>{`@keyframes pulse{0%,100%{opacity:.3}50%{opacity:.6}}`}</style>
        </div>
      )}

      {!loading && stale && (
        <div style={{ padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
          <div style={{ fontSize: "20px", marginBottom: "8px" }}>📊</div>
          Price cache empty — populates after next agent run (weekdays 9 AM)
        </div>
      )}

      {!loading && !stale && sorted.length === 0 && (
        <div style={{ padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
          No sector data for this period
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
          {sorted.map(s => {
            const pos = s.returnPct >= 0;
            const barW = (Math.abs(s.returnPct) / maxAbs) * 100;
            const color = pos ? T.green : T.red;
            return (
              <div key={s.symbol} style={{ display: "grid", gridTemplateColumns: "140px 1fr 80px", alignItems: "center", gap: "10px", padding: "4px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", minWidth: 0 }}>
                  <span style={{ fontSize: "11px", fontWeight: 700, color: T.accent, fontFamily: "monospace", minWidth: "36px" }}>{s.symbol}</span>
                  <span style={{ fontSize: "11px", color: T.textSub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</span>
                </div>
                <div style={{ height: "22px", background: T.surface, borderRadius: "4px", overflow: "hidden", position: "relative" }}>
                  <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: "1px", background: T.border, zIndex: 1 }} />
                  <div style={{
                    position: "absolute", top: 0, bottom: 0,
                    width: `${barW / 2}%`,
                    background: `${color}22`,
                    ...(pos ? { left: "50%" } : { right: "50%" }),
                    borderRadius: pos ? "0 3px 3px 0" : "3px 0 0 3px",
                    transition: "width 0.4s ease",
                  }} />
                  <div style={{
                    position: "absolute", top: 0, bottom: 0,
                    width: `${barW / 2}%`,
                    borderRight: pos ? `2px solid ${color}` : undefined,
                    borderLeft: !pos ? `2px solid ${color}` : undefined,
                    ...(pos ? { left: "50%" } : { right: "50%" }),
                    transition: "width 0.4s ease",
                  }} />
                </div>
                <div style={{ fontSize: "12px", fontWeight: 700, fontFamily: "monospace", color, textAlign: "right" }}>
                  {pos ? "+" : ""}{s.returnPct.toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
