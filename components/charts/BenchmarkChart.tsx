"use client";
import { useState, useEffect } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine,
} from "recharts";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", blue: "#60A5FA",
  amber: "#FBBF24", surface: "#13151C",
};

const COLORS = {
  portfolio: "#6366F1",
  VOO: "#34D399",
  QQQ: "#60A5FA",
};

interface PerfRow { date: string; nav: number; }
interface BenchmarkPoint { date: string; portfolio?: number; VOO?: number; QQQ?: number; }

function normalize(rows: { date: string; value: number }[]): { date: string; pct: number }[] {
  if (!rows.length) return [];
  const base = rows[0].value;
  return rows.map(r => ({ date: r.date, pct: parseFloat((((r.value - base) / base) * 100).toFixed(3)) }));
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "6px" }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600, marginBottom: "2px" }}>
          {p.name}: {p.value >= 0 ? "+" : ""}{p.value?.toFixed(2)}%
        </div>
      ))}
    </div>
  );
}

export default function BenchmarkChart({ perfRows }: { perfRows: PerfRow[] }) {
  const [vooCandles, setVooCandles] = useState<any[]>([]);
  const [qqqCandles, setQqqCandles] = useState<any[]>([]);
  const [loadingBench, setLoadingBench] = useState(false);

  useEffect(() => {
    if (perfRows.length === 0) return;
    setLoadingBench(true);
    Promise.all([
      fetch("/api/charts/price-history?symbol=VOO&days=90").then(r => r.json()),
      fetch("/api/charts/price-history?symbol=QQQ&days=90").then(r => r.json()),
    ]).then(([voo, qqq]) => {
      setVooCandles(voo.candles ?? []);
      setQqqCandles(qqq.candles ?? []);
    }).finally(() => setLoadingBench(false));
  }, [perfRows.length]);

  if (perfRows.length < 2) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Portfolio vs Benchmark</div>
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "40px 0" }}>
          Performance history builds after first paper trades close (7 days). Run ResearchAgent + PaperTrader to start.
        </div>
      </div>
    );
  }

  // Align data by date
  const portfolioNorm = normalize(perfRows.map(r => ({ date: r.date, value: r.nav })));
  const vooNorm = normalize(vooCandles.map((c: any) => ({ date: c.date, value: c.close })));
  const qqqNorm = normalize(qqqCandles.map((c: any) => ({ date: c.date, value: c.close })));

  const vooMap = new Map(vooNorm.map(r => [r.date, r.pct]));
  const qqqMap = new Map(qqqNorm.map(r => [r.date, r.pct]));

  const vooDates = vooNorm.map(r => r.date).sort();

  function closestDate(target: string): string {
    let best = vooDates[0];
    for (const d of vooDates) { if (d <= target) best = d; }
    return best;
  }

  const chartData: BenchmarkPoint[] = portfolioNorm.map(r => ({
    date: r.date,
    portfolio: r.pct,
    VOO: vooMap.get(closestDate(r.date)),
    QQQ: qqqMap.get(closestDate(r.date)),
  }));

  const lastPortfolio = portfolioNorm[portfolioNorm.length - 1]?.pct ?? 0;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600 }}>Portfolio vs Benchmark (% return)</div>
        <div style={{ fontSize: "13px", fontWeight: 700, color: lastPortfolio >= 0 ? T.green : T.red }}>
          {lastPortfolio >= 0 ? "+" : ""}{lastPortfolio.toFixed(2)}%
        </div>
      </div>
      {loadingBench && <div style={{ color: T.muted, fontSize: "12px", marginBottom: "8px" }}>Loading benchmarks…</div>}
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(1) + "%"} width={50} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke={T.border} />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
          <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={COLORS.portfolio} strokeWidth={2.5} dot={false} />
          {vooNorm.length > 0 && <Line type="monotone" dataKey="VOO" stroke={COLORS.VOO} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />}
          {qqqNorm.length > 0 && <Line type="monotone" dataKey="QQQ" stroke={COLORS.QQQ} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
