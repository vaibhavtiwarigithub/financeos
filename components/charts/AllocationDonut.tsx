"use client";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { CURRENCY, type Market } from "@/lib/market-context";

const T = { card: "#1A1D27", border: "#252836", muted: "#6B7280", text: "#ECEDEF" };

const PALETTE = ["#6366F1", "#34D399", "#60A5FA", "#FBBF24", "#F87171", "#A78BFA", "#34D3A0", "#F472B6"];

interface Position { symbol: string; qty: number; avg_cost: number; current_price?: number; }

function CustomTooltip({ active, payload, cur }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
      <div style={{ fontWeight: 700 }}>{d.name}</div>
      <div style={{ color: T.muted }}>{cur}{d.value.toFixed(0)} ({d.pct.toFixed(1)}%)</div>
    </div>
  );
}

// `positions`/`cash` come from ONE market's pool (the caller filters). The total
// below is a within-market sum only — never mix a ₹ pool with a $ pool.
export default function AllocationDonut({ positions, cash, market = "us" }: { positions: Position[]; cash: number; market?: Market }) {
  const cur = CURRENCY[market] ?? "$";
  const posData = positions.map((p, i) => {
    const price = p.current_price ?? p.avg_cost;
    return { name: p.symbol, value: price * p.qty, color: PALETTE[i % PALETTE.length] };
  });

  const total = posData.reduce((s, d) => s + d.value, 0) + cash;
  const chartData = [
    ...posData.map(d => ({ ...d, pct: (d.value / total) * 100 })),
    { name: "Cash", value: cash, pct: (cash / total) * 100, color: "#374151" },
  ].filter(d => d.value > 0);

  if (chartData.length === 0 || total === 0) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Allocation</div>
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No positions yet</div>
      </div>
    );
  }

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Allocation</div>
      <div style={{ fontSize: "12px", color: T.muted, marginBottom: "12px" }}>Total: {cur}{total.toFixed(0)}</div>
      <ResponsiveContainer width="100%" height={200}>
        <PieChart>
          <Pie data={chartData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} paddingAngle={2} dataKey="value">
            {chartData.map((d, i) => <Cell key={i} fill={d.color} />)}
          </Pie>
          <Tooltip content={<CustomTooltip cur={cur} />} />
          <Legend
            formatter={(v) => <span style={{ fontSize: "11px", color: T.text }}>{v}</span>}
            iconSize={8}
            iconType="circle"
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
