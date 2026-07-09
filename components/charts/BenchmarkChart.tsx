"use client";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine,
} from "recharts";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", blue: "#60A5FA",
  amber: "#FBBF24", surface: "#13151C",
};

const COLORS = { portfolio: "#6366F1", bench: "#34D399" };

interface PerfRow { date: string; nav: number; bench_return_pct?: number | null }

function normalize(rows: { date: string; value: number }[]): { date: string; pct: number }[] {
  if (!rows.length) return [];
  const base = rows[0].value;
  if (!base) return rows.map(r => ({ date: r.date, pct: 0 }));
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

// Portfolio cumulative %-return vs its market benchmark (US = VOO, India =
// NIFTY 50). The benchmark line is the stored bench_return_pct series from
// paper_performance — computed server-side per market — so this is correct for
// both markets and needs no client-side index fetch.
export default function BenchmarkChart({ perfRows, market = "us" }: { perfRows: PerfRow[]; market?: string }) {
  const benchLabel = market === "india" ? "NIFTY 50" : "VOO";

  if ((perfRows?.length ?? 0) < 2) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Portfolio vs Benchmark</div>
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "40px 0" }}>
          Performance history builds after the first paper trades. Run ResearchAgent + PaperTrader to start.
        </div>
      </div>
    );
  }

  const portfolioNorm = normalize(perfRows.map(r => ({ date: r.date, value: Number(r.nav) })));
  const chartData = portfolioNorm.map((r, i) => ({
    date: r.date,
    portfolio: r.pct,
    bench: perfRows[i]?.bench_return_pct != null ? Number(perfRows[i].bench_return_pct) : null,
  }));
  const hasBench = chartData.some(d => d.bench != null);

  const lastPortfolio = portfolioNorm[portfolioNorm.length - 1]?.pct ?? 0;
  const lastBench = [...chartData].reverse().find(d => d.bench != null)?.bench ?? null;
  const alpha = lastBench != null ? lastPortfolio - lastBench : null;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "6px", marginBottom: "16px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600 }}>Portfolio vs {benchLabel} (% return)</div>
        <div style={{ display: "flex", gap: "14px", alignItems: "baseline" }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: lastPortfolio >= 0 ? T.green : T.red }}>
            {lastPortfolio >= 0 ? "+" : ""}{lastPortfolio.toFixed(2)}%
          </div>
          {alpha != null && (
            <div style={{ fontSize: "12px", fontWeight: 600, color: alpha >= 0 ? T.green : T.red }}>
              α {alpha >= 0 ? "+" : ""}{alpha.toFixed(2)}%
            </div>
          )}
        </div>
      </div>
      {!hasBench && (
        <div style={{ color: T.muted, fontSize: "12px", marginBottom: "8px" }}>
          {benchLabel} benchmark appears once a paper run records it.
        </div>
      )}
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => v.toFixed(1) + "%"} width={50} />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke={T.border} />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
          <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={COLORS.portfolio} strokeWidth={2.5} dot={false} />
          {hasBench && <Line type="monotone" dataKey="bench" name={benchLabel} stroke={COLORS.bench} strokeWidth={1.5} dot={false} strokeDasharray="4 2" connectNulls />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
