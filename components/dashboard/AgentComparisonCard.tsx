"use client";
import { useEffect, useState } from "react";
import { fmtMoney, type Mkt } from "@/lib/format-money";

const T = {
  bg: "#1A1D27",
  border: "#252836",
  text: "#ECEDEF",
  textSub: "#9B9EA8",
  muted: "#6B7280",
  accent: "#6366F1",
  green: "#34D399",
  red: "#F87171",
  greenBg: "#052E16",
  redBg: "#3B0000",
  surface: "#13151C",
};

type MarketStat = {
  market: Mkt;
  label: string;
  currency: string;
  signalCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgAnalystScore: number | null;
  totalRealizedPnl: number;
  bestTrade: { symbol: string; pnl: number } | null;
  worstTrade: { symbol: string; pnl: number } | null;
};

function signed(n: number, market: Mkt) {
  return (n >= 0 ? "+" : "-") + fmtMoney(Math.abs(n), market);
}

function pnlColor(n: number) {
  return n >= 0 ? T.green : T.red;
}

function MarketColumn({ stat }: { stat: MarketStat }) {
  const isIndia = stat.market === "india";
  const hasData = stat.signalCount > 0 || stat.tradeCount > 0;

  return (
    <div
      style={{
        flex: 1,
        minWidth: "280px",
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        padding: "20px",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      {/* Label header */}
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: isIndia ? "#F59E0B" : T.green, flexShrink: 0 }} />
        <div style={{ fontWeight: 700, fontSize: "15px", color: T.text }}>{stat.label}</div>
        <div
          style={{
            fontSize: "10px", fontWeight: 600, padding: "2px 7px", borderRadius: "20px",
            background: T.bg, color: T.muted, border: `1px solid ${T.border}`,
            textTransform: "uppercase", letterSpacing: "0.06em",
          }}
        >
          {isIndia ? "₹ NSE" : "$ US"}
        </div>
      </div>

      {!hasData ? (
        <div style={{ fontSize: "12px", color: T.muted, textAlign: "center", padding: "20px 0", lineHeight: "1.6" }}>
          No {stat.label} data yet.
          <br />
          Populates after the {isIndia ? "India" : "US"} research → paper pipeline runs.
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            {[
              { label: "Signals", value: String(stat.signalCount), color: T.text },
              { label: "Paper Trades", value: String(stat.tradeCount), color: T.text },
              {
                label: "Win Rate",
                value: stat.winRate != null ? `${stat.winRate}%` : "—",
                color: stat.winRate == null ? T.muted : stat.winRate >= 60 ? T.green : stat.winRate >= 40 ? "#FBBF24" : T.red,
              },
              { label: "W / L", value: `${stat.wins} / ${stat.losses}`, color: T.textSub },
              {
                label: "Avg Score",
                value: stat.avgAnalystScore != null ? String(stat.avgAnalystScore) : "—",
                color: stat.avgAnalystScore == null ? T.muted : stat.avgAnalystScore >= 75 ? T.green : stat.avgAnalystScore >= 60 ? "#FBBF24" : T.red,
              },
              {
                label: "Total P&L",
                value: stat.tradeCount > 0 ? signed(stat.totalRealizedPnl, stat.market) : "—",
                color: stat.tradeCount === 0 ? T.muted : pnlColor(stat.totalRealizedPnl),
              },
            ].map((row) => (
              <div key={row.label} style={{ background: T.bg, borderRadius: "8px", padding: "10px 12px", border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "4px" }}>
                  {row.label}
                </div>
                <div style={{ fontSize: "18px", fontWeight: 700, color: row.color }}>{row.value}</div>
              </div>
            ))}
          </div>

          {(stat.bestTrade || stat.worstTrade) && (
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {stat.bestTrade && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.greenBg, border: `1px solid ${T.green}30`, borderRadius: "7px", padding: "8px 12px", fontSize: "12px" }}>
                  <span style={{ color: T.textSub }}>Best: <span style={{ fontWeight: 700, color: T.text }}>{stat.bestTrade.symbol}</span></span>
                  <span style={{ color: T.green, fontWeight: 700 }}>{signed(stat.bestTrade.pnl, stat.market)}</span>
                </div>
              )}
              {stat.worstTrade && stat.worstTrade.symbol !== stat.bestTrade?.symbol && (
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: T.redBg, border: `1px solid ${T.red}30`, borderRadius: "7px", padding: "8px 12px", fontSize: "12px" }}>
                  <span style={{ color: T.textSub }}>Worst: <span style={{ fontWeight: 700, color: T.text }}>{stat.worstTrade.symbol}</span></span>
                  <span style={{ color: T.red, fontWeight: 700 }}>{signed(stat.worstTrade.pnl, stat.market)}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AgentComparisonCard() {
  const [stats, setStats] = useState<MarketStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/agents/comparison")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) throw new Error(d.error);
        setStats(d.stats ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "20px" }}>
      <div style={{ marginBottom: "16px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "4px" }}>
          Market Comparison
        </div>
        <div style={{ fontSize: "15px", fontWeight: 700, color: T.text }}>Paper Performance · US vs India</div>
        <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>
          Same research → paper pipeline, each market in its own currency (never summed).
        </div>
      </div>

      {loading && <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>Loading comparison…</div>}
      {!loading && error && <div style={{ color: T.red, fontSize: "12px" }}>Error: {error}</div>}
      {!loading && !error && (
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          {stats.map((s) => (
            <MarketColumn key={s.market} stat={s} />
          ))}
        </div>
      )}
    </div>
  );
}
