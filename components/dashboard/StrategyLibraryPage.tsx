"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "./PageHeader";
import { ALGO_STRATEGIES, type AlgoStrategy } from "@/lib/strategy-definitions";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00",
};

const REGIME_COLORS: Record<string, { bg: string; color: string }> = {
  BULL:           { bg: "#052E16", color: "#34D399" },
  LOW_VIX:        { bg: "#052E16", color: "#34D399" },
  TRENDING:       { bg: "#052E16", color: "#34D399" },
  NEUTRAL:        { bg: "#1A1D27", color: "#9B9EA8" },
  RATE_STABLE:    { bg: "#1A1D27", color: "#9B9EA8" },
  SIDEWAYS:       { bg: "#2D1B00", color: "#FBBF24" },
  RANGE_BOUND:    { bg: "#2D1B00", color: "#FBBF24" },
  HIGH_VIX:       { bg: "#2D1B00", color: "#FBBF24" },
  BEAR:           { bg: "#3B0000", color: "#F87171" },
  LATE_CYCLE:     { bg: "#3B0000", color: "#F87171" },
  RATE_HIGH:      { bg: "#3B0000", color: "#F87171" },
  ALL:            { bg: "#1A1D27", color: "#9B9EA8" },
  EARNINGS_SEASON:{ bg: "#1A2040", color: "#818CF8" },
};

function SharpeBar({ low, high }: { low: number; high: number }) {
  const max = 2.0;
  const l = Math.min(1, low / max);
  const h = Math.min(1, high / max);
  return (
    <div style={{ position: "relative", height: "6px", background: T.border, borderRadius: "3px" }}>
      <div style={{
        position: "absolute", left: `${l * 100}%`, width: `${(h - l) * 100}%`,
        height: "100%", background: high >= 1.0 ? T.green : high >= 0.5 ? T.amber : T.red,
        borderRadius: "3px",
      }} />
    </div>
  );
}

function StrategyCard({ strategy, onScan }: { strategy: AlgoStrategy; onScan: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const router = useRouter();

  function goBacktest() {
    const p = strategy.backtest_defaults;
    const q = new URLSearchParams({
      score_threshold: String(p.score_threshold),
      target_pct:      String(p.target_pct),
      stop_loss_pct:   String(p.stop_loss_pct),
      max_hold_days:   String(p.max_hold_days),
      strategy_id:     strategy.id,
    });
    router.push(`/dashboard/backtest?${q.toString()}`);
  }

  const wr = strategy.typical;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{ padding: "18px 20px", cursor: "pointer" }}
        onClick={() => setExpanded(!expanded)}
      >
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "10px", marginBottom: "8px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "22px" }}>{strategy.icon}</span>
            <div>
              <div style={{ fontSize: "15px", fontWeight: 700, color: T.text }}>{strategy.name}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{strategy.tagline}</div>
            </div>
          </div>
          <span style={{ fontSize: "16px", color: T.muted, flexShrink: 0 }}>{expanded ? "▲" : "▼"}</span>
        </div>

        {/* Regime badges */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>
          {strategy.regimes.map(r => {
            const c = REGIME_COLORS[r] ?? { bg: T.card, color: T.muted };
            return (
              <span key={r} style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "20px", background: c.bg, color: c.color, fontWeight: 600, letterSpacing: "0.05em" }}>
                {r.replace(/_/g, " ")}
              </span>
            );
          })}
        </div>

        {/* Quick stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "8px" }}>
          {[
            { label: "Win Rate", value: `${wr.win_rate_low}–${wr.win_rate_high}%` },
            { label: "Sharpe",   value: `${wr.sharpe_low}–${wr.sharpe_high}` },
            { label: "Avg Hold", value: `${wr.avg_hold_days}d` },
          ].map(({ label, value }) => (
            <div key={label} style={{ background: T.surface, borderRadius: "8px", padding: "8px 10px" }}>
              <div style={{ fontSize: "10px", color: T.muted, marginBottom: "3px" }}>{label}</div>
              <div style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Sharpe range bar */}
        <div style={{ marginTop: "10px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: T.muted, marginBottom: "4px" }}>
            <span>Sharpe range</span>
            <span>{wr.sharpe_low} → {wr.sharpe_high} (0 to 2 scale)</span>
          </div>
          <SharpeBar low={wr.sharpe_low} high={wr.sharpe_high} />
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div style={{ borderTop: `1px solid ${T.border}`, padding: "18px 20px" }}>
          <p style={{ fontSize: "13px", color: T.sub, lineHeight: 1.6, marginBottom: "16px" }}>{strategy.description}</p>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "14px", marginBottom: "16px" }}>
            <div>
              <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>Works when</div>
              <ul style={{ margin: 0, padding: "0 0 0 14px" }}>
                {strategy.best_when.map((w, i) => (
                  <li key={i} style={{ fontSize: "11px", color: T.sub, marginBottom: "3px" }}>{w}</li>
                ))}
              </ul>
            </div>
            <div>
              <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>Failure modes</div>
              <ul style={{ margin: 0, padding: "0 0 0 14px" }}>
                {strategy.failure_modes.map((f, i) => (
                  <li key={i} style={{ fontSize: "11px", color: "#F8717199", marginBottom: "3px" }}>{f}</li>
                ))}
              </ul>
            </div>
          </div>

          <div style={{ background: T.surface, borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "5px" }}>Why it works (edge)</div>
            <p style={{ fontSize: "12px", color: T.sub, margin: 0, lineHeight: 1.5 }}>{strategy.edge_explanation}</p>
          </div>

          <div style={{ background: T.surface, borderRadius: "8px", padding: "10px 14px", marginBottom: "14px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>Position sizing</div>
            <div style={{ fontSize: "12px", color: T.sub }}>{strategy.position_sizing}</div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{strategy.kelly_note}</div>
          </div>

          {/* Backtest defaults */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "6px", marginBottom: "16px" }}>
            {Object.entries(strategy.backtest_defaults).map(([k, v]) => (
              <div key={k} style={{ background: `${T.accent}15`, border: `1px solid ${T.accent}30`, borderRadius: "6px", padding: "6px 8px", textAlign: "center" }}>
                <div style={{ fontSize: "9px", color: T.muted, marginBottom: "2px" }}>{k.replace(/_/g, " ")}</div>
                <div style={{ fontSize: "13px", fontWeight: 700, color: T.accent }}>{v}{k.includes("pct") ? "%" : k.includes("days") ? "d" : ""}</div>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={() => onScan(strategy.id)}
              style={{ flex: 1, padding: "10px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              ⟐ Find Candidates
            </button>
            <button
              onClick={goBacktest}
              style={{ flex: 1, padding: "10px", background: T.accent, border: "none", borderRadius: "8px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
            >
              ⏮ Backtest
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function StrategyLibraryPage() {
  const router = useRouter();

  function handleScan(strategyId: string) {
    router.push(`/dashboard/scanner?strategy=${strategyId}`);
  }

  return (
    <div>
      <PageHeader
        title="Strategy Library"
        subtitle="8 pre-defined algo strategies — conditions, edge explanation, typical Sharpe, failure modes"
        cadence="as-needed"
        whatItDoes="Encyclopedic reference for 8 core algo trading strategies. Each shows the regime it works in, why the edge exists (academic citations), typical win rate and Sharpe range, failure modes, and pre-loaded backtest parameters. Click 'Find Candidates' to scan for symbols that match the strategy conditions. Click 'Backtest' to pre-fill the backtest page with optimal params for that strategy."
        whatToLookFor={[
          "Match strategy to current macro regime — Momentum in bull, Mean Reversion in high-VIX, Value in late cycle.",
          "Sharpe < 0.5 in typical range = strategy needs combination with other signals to be viable.",
          "Failure modes tell you WHEN to stop using a strategy — as important as when to use it.",
          "Edge explanation = the academic or behavioral reason the alpha exists. If you can't explain it, don't trade it.",
        ]}
      />

      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) 40px" }}>
        {/* Sub-nav: Fit Scores ↔ Algo Library (this page) */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "20px", borderBottom: `1px solid ${T.border}`, paddingBottom: "0" }}>
          <a href="/dashboard/strategies" style={{ padding: "8px 14px", fontSize: "13px", fontWeight: 600, color: T.muted, textDecoration: "none", borderBottom: "2px solid transparent" }}>← Fit Scores</a>
          <div style={{ padding: "8px 14px", fontSize: "13px", fontWeight: 600, color: T.accent, borderBottom: `2px solid ${T.accent}`, marginBottom: "-1px" }}>Algo Library</div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 300px), 1fr))", gap: "14px" }}>
          {ALGO_STRATEGIES.map(s => (
            <StrategyCard key={s.id} strategy={s} onScan={handleScan} />
          ))}
        </div>
      </div>
    </div>
  );
}
