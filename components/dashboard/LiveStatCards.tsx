"use client";
import { maskText } from "@/components/dashboard/PrivacyMask";
import { fmtMoney } from "@/lib/format-money";

// Shared 5-card summary row for the Live Portfolio views (US $ and India ₹).
// Currency-aware via the market-tagged fmtMoney; privacy-mask aware. Rendered
// identically by both the US Live page and the India (Kite) Live panel so the
// two look the same.
const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#6B7280",
  green: "#34D399", red: "#F87171",
};

function Card({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 20px", flex: 1, minWidth: "150px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

export default function LiveStatCards({
  market,
  equity,
  buyingPower,
  positions,
  invested,
  totalPnl,
  totalPnlPct,
  dayPnl,
  brokerLabel,
  masked = false,
}: {
  market: "us" | "india";
  equity: number;
  buyingPower: number | null;
  positions: number;
  invested: number;
  totalPnl: number;
  totalPnlPct: number;
  dayPnl: number | null;
  brokerLabel: string;
  masked?: boolean;
}) {
  const m = (v: number) => maskText(fmtMoney(v, market), masked);
  const pct = (v: number) => maskText((v >= 0 ? "+" : "") + v.toFixed(2) + "%", masked);

  return (
    <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
      <Card label="Total Equity" value={m(equity)} sub={`Live · ${brokerLabel}`} />
      <Card label="Buying Power" value={buyingPower != null ? m(buyingPower) : "—"} color={T.green} />
      <Card label="Positions" value={masked ? "••" : String(positions)} sub={positions > 0 && invested > 0 ? maskText(fmtMoney(invested, market) + " invested", masked) : undefined} />
      <Card label="Total P&L" value={m(totalPnl)} sub={totalPnlPct !== 0 ? pct(totalPnlPct) : undefined} color={totalPnl >= 0 ? T.green : T.red} />
      <Card label="Day P&L" value={dayPnl != null && dayPnl !== 0 ? m(dayPnl) : "—"} color={(dayPnl ?? 0) >= 0 ? T.green : T.red} />
    </div>
  );
}
