"use client";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } from "recharts";

const T = { card: "#1A1D27", border: "#252836", muted: "#6B7280", green: "#34D399", red: "#F87171", text: "#ECEDEF" };

interface Trade { id: string; symbol: string; realized_pnl?: number; outcome?: string; executed_at: string; }

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const val = payload[0].value;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
      <div style={{ fontWeight: 700 }}>{label}</div>
      <div style={{ color: val >= 0 ? T.green : T.red, fontWeight: 600 }}>{val >= 0 ? "+" : ""}${Math.abs(val).toFixed(2)}</div>
    </div>
  );
}

export default function PnlBarChart({ trades }: { trades: Trade[] }) {
  const closed = trades.filter(t => t.realized_pnl != null).slice(-20);

  if (closed.length === 0) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Trade P&L</div>
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No closed trades yet</div>
      </div>
    );
  }

  const data = closed.map(t => ({
    name: t.symbol,
    pnl: parseFloat((t.realized_pnl ?? 0).toFixed(2)),
  }));

  const totalPnl = data.reduce((s, d) => s + d.pnl, 0);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600 }}>Trade P&L</div>
        <div style={{ fontSize: "13px", fontWeight: 700, color: totalPnl >= 0 ? T.green : T.red }}>
          Total: {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => "$" + v} width={45} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke={T.border} />
          <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
            {data.map((d, i) => <Cell key={i} fill={d.pnl >= 0 ? T.green : T.red} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
