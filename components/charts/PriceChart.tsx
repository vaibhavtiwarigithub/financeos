"use client";
import { useState, useEffect } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ReferenceArea,
} from "recharts";

// Hard-coded major US recessions (NBER-dated)
const RECESSIONS = [
  { start: "2001-03-01", end: "2001-11-01", label: "Dot-com" },
  { start: "2007-12-01", end: "2009-06-01", label: "GFC" },
  { start: "2020-02-01", end: "2020-04-01", label: "COVID" },
];

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", surface: "#13151C",
};

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

const PERIODS = [
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "6M", days: 180 },
];

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  const isUp = d.close >= d.open;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "4px" }}>{label}</div>
      <div style={{ fontWeight: 700, color: isUp ? T.green : T.red, fontSize: "14px" }}>${d.close?.toFixed(2)}</div>
      <div style={{ color: T.muted, marginTop: "2px" }}>O: {d.open?.toFixed(2)} H: {d.high?.toFixed(2)} L: {d.low?.toFixed(2)}</div>
    </div>
  );
}

export default function PriceChart({
  symbol,
  height = 280,
  showRecessions = false,
}: {
  symbol: string;
  height?: number;
  showRecessions?: boolean;
}) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState(PERIODS[1]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) return;
    setLoading(true);
    setError(null);
    fetch(`/api/charts/price-history?symbol=${symbol}&days=${period.days}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); setCandles([]); }
        else setCandles(d.candles ?? []);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, period]);

  const visible = candles.slice(-period.days);
  const firstClose = visible[0]?.close ?? 0;
  const lastClose = visible[visible.length - 1]?.close ?? 0;
  const isUp = lastClose >= firstClose;
  const changePct = firstClose ? (((lastClose - firstClose) / firstClose) * 100).toFixed(2) : "0.00";
  const lineColor = isUp ? T.green : T.red;

  const formatDate = (d: string) => {
    const dt = new Date(d + "T00:00:00");
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: "15px" }}>{symbol}</span>
          {lastClose > 0 && (
            <>
              <span style={{ fontSize: "20px", fontWeight: 700, marginLeft: "12px" }}>${lastClose.toFixed(2)}</span>
              <span style={{ fontSize: "13px", marginLeft: "8px", color: isUp ? T.green : T.red, fontWeight: 600 }}>
                {isUp ? "+" : ""}{changePct}% ({period.label})
              </span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: "4px" }}>
          {PERIODS.map(p => (
            <button key={p.label} onClick={() => setPeriod(p)} style={{ padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none", background: period.label === p.label ? T.accent : T.surface, color: period.label === p.label ? "#fff" : T.muted }}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px" }}>
          Fetching {symbol} prices… (30–60s first load, cached after)
        </div>
      )}
      {error && !loading && (
        <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: T.red, fontSize: "13px" }}>{error}</div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px" }}>No data available</div>
      )}
      {!loading && !error && visible.length > 0 && (
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={visible} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={formatDate}
              tick={{ fontSize: 10, fill: T.muted }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={["auto", "auto"]}
              tick={{ fontSize: 10, fill: T.muted }}
              tickLine={false}
              axisLine={false}
              tickFormatter={v => "$" + v.toFixed(0)}
              width={55}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={firstClose} stroke={T.border} strokeDasharray="4 4" />
            {/* Recession shading — only renders when the chart's date range overlaps a recession */}
            {showRecessions && visible.length >= 2 && RECESSIONS.map(rec => {
              const chartStart = visible[0].date;
              const chartEnd = visible[visible.length - 1].date;
              // Only include if recession overlaps the visible range
              if (rec.end < chartStart || rec.start > chartEnd) return null;
              const x1 = rec.start > chartStart ? rec.start : chartStart;
              const x2 = rec.end < chartEnd ? rec.end : chartEnd;
              return (
                <ReferenceArea
                  key={rec.label}
                  x1={x1}
                  x2={x2}
                  fill="#F87171"
                  fillOpacity={0.08}
                  stroke="#F87171"
                  strokeOpacity={0.15}
                  label={{ value: rec.label, position: "insideTop", fontSize: 9, fill: "#F87171", opacity: 0.6 }}
                />
              );
            })}
            <Line
              type="monotone"
              dataKey="close"
              stroke={lineColor}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: lineColor }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
