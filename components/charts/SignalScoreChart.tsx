"use client";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Cell, ScatterChart, Scatter, ZAxis,
} from "recharts";

const T = { card: "#1A1D27", border: "#252836", muted: "#6B7280", green: "#34D399", red: "#F87171", accent: "#6366F1", amber: "#FBBF24", text: "#ECEDEF" };

interface Signal { id: string; symbol: string; analyst_score: number; conviction: number; direction: string; created_at: string; }

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
      <div style={{ fontWeight: 700 }}>{d.symbol}</div>
      <div style={{ color: T.accent }}>Score: {d.analyst_score}</div>
      <div style={{ color: d.direction === "long" ? T.green : T.amber }}>
        {d.direction?.toUpperCase()} · conviction {d.conviction}
      </div>
    </div>
  );
}

// Bar chart: latest signal score per symbol
export function SignalScoreBar({ signals }: { signals: Signal[] }) {
  // Latest signal per symbol
  const bySymbol = new Map<string, Signal>();
  for (const s of signals) {
    if (!bySymbol.has(s.symbol) || new Date(s.created_at) > new Date(bySymbol.get(s.symbol)!.created_at)) {
      bySymbol.set(s.symbol, s);
    }
  }
  const data = [...bySymbol.values()].sort((a, b) => b.analyst_score - a.analyst_score);

  if (data.length === 0) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Signal Scores</div>
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No signals yet</div>
      </div>
    );
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px" }}>Signal Scores by Symbol</div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="symbol" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="analyst_score" radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.analyst_score >= 70 ? T.green : d.analyst_score >= 50 ? T.accent : T.red} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {/* Threshold line note */}
      <div style={{ fontSize: "10px", color: T.muted, marginTop: "6px", textAlign: "right" }}>
        Green ≥ 70 · Purple ≥ 50 · Red &lt; 50 · Trade threshold: 60
      </div>
    </div>
  );
}

// Score vs Conviction scatter
export function ScoreConvictionScatter({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) return null;
  const data = signals.map(s => ({
    ...s,
    x: s.analyst_score,
    y: s.conviction,
    z: 50,
  }));

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px" }}>Score vs Conviction</div>
      <ResponsiveContainer width="100%" height={160}>
        <ScatterChart margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" />
          <XAxis type="number" dataKey="x" name="Score" domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} label={{ value: "Score", position: "insideBottom", offset: -2, fill: T.muted, fontSize: 10 }} />
          <YAxis type="number" dataKey="y" name="Conviction" domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} />
          <ZAxis type="number" dataKey="z" range={[40, 40]} />
          <Tooltip content={<CustomTooltip />} />
          <Scatter data={data} fill={T.accent} opacity={0.8} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
