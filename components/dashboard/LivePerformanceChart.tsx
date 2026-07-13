"use client";
import { useState, useEffect, useCallback } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

// Shared live-portfolio performance chart, market-aware. Self-fetches
// /api/live-portfolio/performance?market=&period=&accounts= and draws the
// portfolio cumulative-% curve vs its benchmark (US = VOO, India = NIFTY 50),
// both rebased to 0 at the first point in the window. Used by BOTH the US Live
// view and the India (Kite) Live panel so the two look identical.
const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", dim: "#1C1F26", accent: "#6366F1",
  green: "#34D399", greenBg: "#052E16", red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
};

const TIMEFRAMES = ["1D", "1W", "1M", "3M", "YTD", "1Y", "All"] as const;
type TF = typeof TIMEFRAMES[number];

const HOLDING_COLORS = [
  "#6366F1", "#34D399", "#60A5FA", "#FBBF24", "#F87171",
  "#A78BFA", "#F59E0B", "#10B981", "#EC4899", "#14B8A6",
];

type ChartPoint = { date: string; portfolio: number; bench?: number; [key: string]: any };

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function LivePerformanceChart({
  market = "us",
  accounts,
  showHoldingsToggle = false,
}: {
  market?: "us" | "india";
  accounts?: string[];
  showHoldingsToggle?: boolean;
}) {
  const [period, setPeriod] = useState<TF>("1M");
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [chartSymbols, setChartSymbols] = useState<string[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [showHoldingLines, setShowHoldingLines] = useState(false);
  const [estimated, setEstimated] = useState(false);
  const [benchSymbol, setBenchSymbol] = useState(market === "india" ? "NIFTY 50" : "VOO");

  const acctKey = (accounts ?? []).join(",");

  const loadChart = useCallback(async (tf: TF) => {
    setLoadingChart(true);
    setChartData([]);
    try {
      const acctParam = accounts && accounts.length > 0 ? `&accounts=${accounts.join(",")}` : "";
      const r = await fetch(`/api/live-portfolio/performance?period=${tf}&market=${market}${acctParam}`);
      const d = await r.json();
      if (!d.dates || d.dates.length === 0) { setChartData([]); return; }
      const points: ChartPoint[] = d.dates.map((date: string, i: number) => {
        const pt: ChartPoint = { date: fmtDate(date), portfolio: d.portfolio[i] };
        if (Array.isArray(d.benchmark) && typeof d.benchmark[i] === "number") pt.bench = d.benchmark[i];
        for (const h of (d.holdings ?? [])) pt[h.symbol] = h.data[i];
        return pt;
      });
      setChartData(points);
      setChartSymbols((d.holdings ?? []).map((h: any) => h.symbol));
      setEstimated(!!d.estimated);
      setBenchSymbol(d.benchSymbol ?? (market === "india" ? "NIFTY 50" : "VOO"));
    } catch {
      // non-fatal
    } finally {
      setLoadingChart(false);
    }
  }, [market, acctKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadChart(period); }, [period, loadChart]);

  const lastPt = chartData[chartData.length - 1];
  const portfolioLastPct = lastPt && typeof lastPt.portfolio === "number" ? lastPt.portfolio : null;
  const benchLastPct = lastPt && typeof lastPt.bench === "number" ? lastPt.bench : null;
  const benchDelta = portfolioLastPct != null && benchLastPct != null
    ? parseFloat((portfolioLastPct - benchLastPct).toFixed(2)) : null;
  const hasBench = chartData.some(p => typeof p.bench === "number");

  const estTitle = market === "india"
    ? "No live Kite equity history yet, so this shows the PAPER India NIFTY curve as a stand-in. Once ≥2 daily Kite snapshots accrue, the real live-equity curve replaces it automatically."
    : "No real daily history yet, so this reconstructs the curve from your CURRENT holdings × each symbol's price history — it assumes today's share counts were held throughout, so it distorts where positions changed. Real broker-equity tracking accrues daily and replaces this automatically.";

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px", marginBottom: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px", gap: "10px", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Performance <span style={{ textTransform: "none", letterSpacing: 0, color: T.textSub }}>vs {benchSymbol}</span>
          </div>
          {benchDelta != null && (
            <span style={{
              fontSize: "12px", fontWeight: 800, padding: "2px 9px", borderRadius: "6px",
              color: benchDelta >= 0 ? T.green : T.red,
              background: benchDelta >= 0 ? T.greenBg : T.redBg,
            }}>
              {benchDelta >= 0 ? "+" : ""}{benchDelta.toFixed(2)}% vs {benchSymbol}
            </span>
          )}
          {estimated && chartData.length > 0 && (
            <span title={estTitle}
              style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "5px", background: T.amberBg, color: T.amber, cursor: "help", letterSpacing: "0.04em" }}>
              {market === "india" ? "PAPER PROXY" : "ESTIMATED"}
            </span>
          )}
          {loadingChart && <span style={{ fontSize: "11px", color: T.muted }}>Loading…</span>}
        </div>
        <div style={{ display: "flex", gap: "4px", alignItems: "center", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {TIMEFRAMES.map(tf => (
            <button
              key={tf}
              onClick={() => setPeriod(tf)}
              style={{
                padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                background: period === tf ? T.accent : "none",
                color: period === tf ? "#fff" : T.muted,
                border: `1px solid ${period === tf ? T.accent : T.border}`,
                cursor: "pointer", whiteSpace: "nowrap",
              }}
            >{tf}</button>
          ))}
          {showHoldingsToggle && (
            <>
              <div style={{ width: "1px", height: "20px", background: T.border, margin: "0 4px" }} />
              <button
                onClick={() => setShowHoldingLines(s => !s)}
                style={{
                  padding: "4px 10px", borderRadius: "6px", fontSize: "11px", fontWeight: 600,
                  background: showHoldingLines ? "#1E1F3A" : "none",
                  color: showHoldingLines ? T.accent : T.muted,
                  border: `1px solid ${showHoldingLines ? T.accent + "44" : T.border}`,
                  cursor: "pointer", whiteSpace: "nowrap",
                }}
              >Holdings</button>
            </>
          )}
        </div>
      </div>

      {chartData.length === 0 && !loadingChart ? (
        <div style={{ height: "200px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px", flexDirection: "column", gap: "6px" }}>
          <div>Not enough history yet</div>
          <div style={{ fontSize: "11px" }}>
            {market === "india"
              ? "The live Kite-vs-NIFTY curve builds forward from each daily sync."
              : <>Needs a synced holdings snapshot + <code style={{ background: T.dim, padding: "1px 4px", borderRadius: "3px" }}>MASSIVE_API_KEY</code> for price history</>}
          </div>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={chartData} margin={{ top: 4, right: 0, left: -10, bottom: 0 }}>
            <defs>
              <linearGradient id={`portfolioGrad-${market}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={T.accent} stopOpacity={0.3} />
                <stop offset="95%" stopColor={T.accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => v + "%"} />
            <Tooltip
              contentStyle={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", fontSize: "12px" }}
              labelStyle={{ color: T.textSub }}
              formatter={(v: any, name: any) => [v?.toFixed(2) + "%", name]}
            />
            {showHoldingLines && chartSymbols.map((sym, i) => (
              <Area key={sym} type="monotone" dataKey={sym}
                stroke={HOLDING_COLORS[i % HOLDING_COLORS.length]} fill="none"
                strokeWidth={1} dot={false} strokeDasharray="4 2" />
            ))}
            <Area type="monotone" dataKey="portfolio" stroke={T.accent}
              fill={`url(#portfolioGrad-${market})`} strokeWidth={2} dot={false} name="Portfolio" />
            {hasBench && (
              <Area type="monotone" dataKey="bench" stroke={T.textSub} fill="none"
                strokeWidth={1.5} dot={false} strokeDasharray="4 2" name={benchSymbol} connectNulls />
            )}
            {(showHoldingLines || hasBench) && <Legend wrapperStyle={{ fontSize: "10px", paddingTop: "8px" }} />}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
