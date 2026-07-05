"use client";
import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import PageHeader from "./PageHeader";
import { useMarket } from "@/lib/market-context";
import { indiaScreenUniverse } from "@/lib/india-universe";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00", redBg: "#3B0000",
};

interface TradeOutcome {
  symbol: string;
  signal_date: string;
  entry_price: number;
  exit_price: number;
  exit_reason: "target" | "stop" | "timeout" | "exit_signal";
  hold_days: number;
  return_pct: number;
  analyst_score: number;
}

interface GateCheck {
  pass: boolean;
  value: number | null;
  threshold: number | null;
}

interface BacktestResult {
  total_trades: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  expectancy: number;
  avg_hold_days: number;
  benchmark_return_pct: number | null;
  benchmark_symbol?: string;
  alpha_pct: number | null;
  market?: "us" | "india";
  currency?: string;
  gate_pass: boolean;
  gate_reasons: Record<string, GateCheck>;
  outcomes: TradeOutcome[];
}

const GATE_LABELS: Record<string, string> = {
  min_trades:     "≥ 20 trades",
  min_expectancy: "Expectancy > 0",
  min_sharpe:     "Sharpe ≥ 0.5",
  max_drawdown:   "Drawdown ≤ 25%",
  min_win_rate:   "Win rate ≥ 40%",
};

function pct(v: number, decimals = 1) {
  return `${v >= 0 ? "+" : ""}${v.toFixed(decimals)}%`;
}

function MetricCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", flex: 1, minWidth: "130px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: T.sub, marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

export default function BacktestPage() {
  const { market } = useMarket();
  const searchParams = useSearchParams();
  const [form, setForm] = useState({
    date_from:       "2025-01-01",
    date_to:         new Date().toISOString().split("T")[0],
    score_threshold: parseInt(searchParams.get("score_threshold") ?? "60"),
    target_pct:      parseInt(searchParams.get("target_pct")      ?? "20"),
    stop_loss_pct:   parseFloat(searchParams.get("stop_loss_pct") ?? "7"),
    max_hold_days:   parseInt(searchParams.get("max_hold_days")   ?? "15"),
  });
  const strategyId = searchParams.get("strategy_id");

  // Show strategy banner if navigated from Library
  const [strategyBanner] = useState(strategyId);

  // Keep form in sync if params change (e.g. navigating between strategies)
  useEffect(() => {
    const st = parseInt(searchParams.get("score_threshold") ?? "0");
    if (st > 0) {
      setForm({
        date_from:       "2025-01-01",
        date_to:         new Date().toISOString().split("T")[0],
        score_threshold: st,
        target_pct:      parseInt(searchParams.get("target_pct")      ?? "20"),
        stop_loss_pct:   parseFloat(searchParams.get("stop_loss_pct") ?? "7"),
        max_hold_days:   parseInt(searchParams.get("max_hold_days")   ?? "15"),
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState<BacktestResult | null>(null);
  const [error, setError]     = useState("");
  const [showTrades, setShowTrades] = useState(false);
  const [sortCol, setSortCol] = useState<keyof TradeOutcome>("signal_date");
  const [sortAsc, setSortAsc] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optimizeResult, setOptimizeResult] = useState<any>(null);

  // Clear stale results when the global market switches (US ↔ India) so a $ run
  // is never shown under a ₹ header or vice versa.
  useEffect(() => { setResult(null); setOptimizeResult(null); setError(""); }, [market]);

  async function runBacktest() {
    setRunning(true);
    setError("");
    setResult(null);
    setOptimizeResult(null);
    try {
      const res = await fetch("/api/agents/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, market }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Unknown error");
      setResult(data.metrics);
    } catch (e: any) { setError(e.message); }
    finally { setRunning(false); }
  }

  async function runOptimize() {
    if (!result) return;
    setOptimizing(true);
    setOptimizeResult(null);
    try {
      const res = await fetch("/api/agents/backtest/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, market }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error ?? "Optimize failed");
      setOptimizeResult(data);
    } catch (e: any) { setError(e.message); }
    finally { setOptimizing(false); }
  }

  const numInp: React.CSSProperties = {
    width: "80px", background: T.surface, border: `1px solid ${T.border}`,
    borderRadius: "8px", color: T.text, fontSize: "13px", padding: "7px 10px",
    outline: "none", textAlign: "right",
  };
  const dateInp: React.CSSProperties = {
    background: T.surface, border: `1px solid ${T.border}`,
    borderRadius: "8px", color: T.text, fontSize: "13px", padding: "7px 10px", outline: "none",
  };

  const sortedTrades = result
    ? [...result.outcomes].sort((a, b) => {
        const av = a[sortCol] as any, bv = b[sortCol] as any;
        return sortAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
      })
    : [];

  function toggleSort(col: keyof TradeOutcome) {
    if (sortCol === col) setSortAsc(!sortAsc);
    else { setSortCol(col); setSortAsc(false); }
  }

  const thStyle: React.CSSProperties = { padding: "7px 10px", textAlign: "left", fontWeight: 600, color: T.muted, cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" };

  return (
    <div>
      <PageHeader
        title="Backtest"
        subtitle="Replay agent signals against historical prices — fully deterministic, no LLM"
        cadence="as-needed"
        whatItDoes="Simulates trades using past agent_signals and price_cache candles. Entry = first close on/after signal date. Exit = target hit, stop hit, or max hold timeout. Computes Sharpe, max drawdown, expectancy, and alpha vs SPY."
        whatToLookFor={[
          "Gate Pass = all 5 thresholds met — minimum viable strategy quality.",
          "Sharpe ≥ 1.0 is strong for a trading strategy.",
          "Expectancy > 0 means the strategy makes money on average — most important single metric.",
          "Alpha vs SPY: are you beating simply buying the index?",
          "Needs price_cache data for the symbols/dates in range — run price cron first if empty.",
        ]}
      />

      <div style={{ padding: "0 28px 40px" }}>

        {/* India universe note — the ₹ backtest replays India signals against free
            Yahoo .NS candles, drawn from the NIFTY-100 screen universe. */}
        {market === "india" && (
          <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}30`, borderRadius: "10px", padding: "10px 16px", marginBottom: "14px", fontSize: "12px", color: T.sub }}>
            <span style={{ color: T.accent, fontWeight: 600 }}>🇮🇳 India (₹) backtest</span> — replays India signals against Yahoo <code>.NS</code> candles. Universe: {indiaScreenUniverse().length} NIFTY-100 names. Benchmark: NIFTY 50 (^NSEI). Prices in ₹.
          </div>
        )}

        {/* Strategy banner */}
        {strategyBanner && (
          <div style={{ background: `${T.accent}10`, border: `1px solid ${T.accent}30`, borderRadius: "10px", padding: "10px 16px", marginBottom: "14px", fontSize: "12px", color: T.sub }}>
            <span style={{ color: T.accent, fontWeight: 600 }}>Strategy Library → {strategyBanner.replace(/_/g, " ")}</span> — params pre-loaded. Adjust if needed then run.
          </div>
        )}

        {/* How this works — explainer */}
        <details style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "14px 18px", marginBottom: "18px" }}>
          <summary style={{ fontSize: "13px", fontWeight: 700, color: T.text, cursor: "pointer" }}>How the backtest works — read me</summary>
          <div style={{ fontSize: "12.5px", color: T.sub, lineHeight: 1.7, marginTop: "10px" }}>
            <p style={{ margin: "0 0 10px" }}>
              <b style={{ color: T.text }}>What it tests:</b> whether the ResearchAgent's <b>scoring strategy has a real edge</b> — not a single stock. It replays your own history: every past <code>agent_signal</code> with an analyst score at or above the <b>Score threshold</b> becomes a simulated trade.
            </p>
            <p style={{ margin: "0 0 10px" }}>
              <b style={{ color: T.text }}>Which symbols:</b> whatever the agent actually signaled over the date range (your researched watchlist names) — you don't pick tickers here; the strategy did, historically. It needs <code>price_cache</code> candles for those symbols/dates (run the price cron if empty).
            </p>
            <p style={{ margin: "0 0 10px" }}>
              <b style={{ color: T.text }}>The rules:</b> enter at the first close on/after the signal date; exit on whichever comes first — <b>+Target%</b>, <b>−Stop%</b>, or <b>Max hold days</b> timeout. Fully deterministic, no LLM. Then it computes win rate, expectancy, Sharpe, max drawdown, and <b>alpha vs SPY</b> (are you beating just buying the index?).
            </p>
            <p style={{ margin: "0 0 10px" }}>
              <b style={{ color: T.text }}>What's "right" for us:</b> this is <b>informational only</b> — a backtest is NOT valid grounds for a live-trade eligibility decision (locked project rule). Use it to sanity-check that the scoring + exit rules would have made money, and to tune target/stop/hold. Real edge is proven by the forward paper record, not the backtest.
            </p>
            <p style={{ margin: 0 }}>
              <b style={{ color: T.text }}>vs other platforms:</b> tools like QuantConnect / Backtrader let you backtest arbitrary coded strategies over full market history. Ours is narrower on purpose — it validates <i>this system's own signals</i> with simple, transparent exit rules, which is what matters for a governed paper-first platform.
            </p>
          </div>
        </details>

        {/* Config form */}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px 24px", marginBottom: "20px" }}>
          <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Backtest Parameters</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "20px", alignItems: "flex-end", marginBottom: "20px" }}>
            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>From</label>
              <input type="date" value={form.date_from} onChange={e => setForm({ ...form, date_from: e.target.value })} style={dateInp} />
            </div>
            <div>
              <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>To</label>
              <input type="date" value={form.date_to} onChange={e => setForm({ ...form, date_to: e.target.value })} style={dateInp} />
            </div>
            {([
              { key: "score_threshold", label: "Min Score",   step: 1, min: 0,  max: 100 },
              { key: "target_pct",      label: "Target %",    step: 1, min: 5,  max: 100 },
              { key: "stop_loss_pct",   label: "Stop Loss %", step: 0.5, min: 1, max: 30 },
              { key: "max_hold_days",   label: "Max Hold Days", step: 1, min: 1, max: 60 },
            ] as const).map(({ key, label, step, min, max }) => (
              <div key={key}>
                <label style={{ fontSize: "12px", color: T.sub, display: "block", marginBottom: "5px" }}>{label}</label>
                <input
                  type="number" step={step} min={min} max={max}
                  value={(form as any)[key]}
                  onChange={e => setForm({ ...form, [key]: parseFloat(e.target.value) || 0 })}
                  style={numInp}
                />
              </div>
            ))}
          </div>
          <button
            onClick={runBacktest}
            disabled={running}
            style={{ background: T.accent, border: "none", borderRadius: "8px", color: "#fff", padding: "11px 28px", fontSize: "14px", fontWeight: 700, cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.7 : 1 }}
          >
            {running ? "⏳ Running backtest…" : "▶ Run Backtest"}
          </button>
          {running && <div style={{ fontSize: "12px", color: T.muted, marginTop: "10px" }}>Replaying signals against price_cache… usually &lt;3s</div>}
        </div>

        {error && (
          <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "10px", padding: "14px 18px", marginBottom: "20px", color: T.red, fontSize: "13px" }}>
            ⚠️ {error}
          </div>
        )}

        {result && (
          <>
            {/* Gate status */}
            <div style={{ background: result.gate_pass ? T.greenBg : T.redBg, border: `1px solid ${result.gate_pass ? T.green : T.red}44`, borderRadius: "12px", padding: "16px 20px", marginBottom: "20px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
                <span style={{ fontSize: "20px" }}>{result.gate_pass ? "✅" : "❌"}</span>
                <span style={{ fontSize: "16px", fontWeight: 700, color: result.gate_pass ? T.green : T.red }}>
                  {result.gate_pass ? "Gate PASS — Strategy meets minimum quality thresholds" : "Gate FAIL — Strategy does not yet meet minimum thresholds"}
                </span>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {Object.entries(result.gate_reasons).map(([key, g]) => (
                  <div key={key} style={{ fontSize: "12px", padding: "5px 12px", borderRadius: "6px", background: g.pass ? "#052E1666" : "#3B000066", border: `1px solid ${g.pass ? T.green : T.red}33`, color: g.pass ? T.green : T.red }}>
                    {g.pass ? "✓" : "✗"} {GATE_LABELS[key] ?? key}
                    {g.value != null && <span style={{ color: T.muted, marginLeft: "4px" }}>({typeof g.value === "number" && g.value < 1 && key !== "min_expectancy" ? (g.value * 100).toFixed(0) + "%" : g.value.toFixed(2)})</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Metrics */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "10px", marginBottom: "20px" }}>
              <MetricCard label="Total Trades" value={`${result.total_trades}`} sub={`avg ${result.avg_hold_days.toFixed(1)} days held`} />
              <MetricCard
                label="Win Rate"
                value={`${(result.win_rate * 100).toFixed(1)}%`}
                sub="≥ 40% threshold"
                color={result.win_rate >= 0.40 ? T.green : T.red}
              />
              <MetricCard
                label="Avg Return"
                value={pct(result.avg_return_pct)}
                sub={`median ${pct(result.median_return_pct)}`}
                color={result.avg_return_pct >= 0 ? T.green : T.red}
              />
              <MetricCard
                label="Sharpe Ratio"
                value={result.sharpe_ratio.toFixed(2)}
                sub="≥ 0.5 threshold"
                color={result.sharpe_ratio >= 1.0 ? T.green : result.sharpe_ratio >= 0.5 ? T.amber : T.red}
              />
              <MetricCard
                label="Max Drawdown"
                value={`-${result.max_drawdown_pct.toFixed(1)}%`}
                sub="≤ 25% threshold"
                color={result.max_drawdown_pct <= 15 ? T.green : result.max_drawdown_pct <= 25 ? T.amber : T.red}
              />
              <MetricCard
                label="Expectancy"
                value={pct(result.expectancy)}
                sub="avg profit per trade"
                color={result.expectancy > 0 ? T.green : T.red}
              />
              {result.alpha_pct != null && (
                <MetricCard
                  label={`Alpha vs ${result.benchmark_symbol === "^NSEI" ? "NIFTY" : "SPY"}`}
                  value={pct(result.alpha_pct)}
                  sub={result.benchmark_return_pct != null ? `${result.benchmark_symbol === "^NSEI" ? "NIFTY" : "SPY"}: ${pct(result.benchmark_return_pct)}` : ""}
                  color={result.alpha_pct >= 0 ? T.green : T.red}
                />
              )}
            </div>

            {/* Return distribution mini chart */}
            {result.outcomes.length > 0 && (() => {
              const returns = result.outcomes.map(o => o.return_pct);
              const min = Math.min(...returns), max = Math.max(...returns);
              const BUCKETS = 20;
              const step = (max - min) / BUCKETS || 1;
              const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ start: min + i * step, count: 0 }));
              for (const r of returns) {
                const idx = Math.min(BUCKETS - 1, Math.floor((r - min) / step));
                buckets[idx].count++;
              }
              const maxCount = Math.max(...buckets.map(b => b.count));
              return (
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
                  <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "12px" }}>Return Distribution ({result.total_trades} trades)</div>
                  <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: "60px" }}>
                    {buckets.map((b, i) => {
                      const isNeg = b.start < 0;
                      return (
                        <div
                          key={i}
                          title={`${b.start.toFixed(1)}%–${(b.start + step).toFixed(1)}%: ${b.count} trades`}
                          style={{
                            flex: 1, height: `${maxCount > 0 ? Math.max(2, (b.count / maxCount) * 60) : 2}px`,
                            background: isNeg ? T.red : T.green, borderRadius: "2px 2px 0 0", opacity: b.count === 0 ? 0.15 : 1,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: "10px", color: T.muted, marginTop: "4px" }}>
                    <span>{min.toFixed(1)}%</span>
                    <span>0%</span>
                    <span>{max.toFixed(1)}%</span>
                  </div>
                </div>
              );
            })()}

            {/* Trade outcomes table */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  Trade Log ({result.total_trades} trades)
                </div>
                <button
                  onClick={() => setShowTrades(!showTrades)}
                  style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.sub, padding: "5px 14px", fontSize: "12px", cursor: "pointer" }}
                >
                  {showTrades ? "Hide" : "Show"} trades
                </button>
              </div>
              {showTrades && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                        {([
                          ["symbol", "Symbol"],
                          ["signal_date", "Date"],
                          ["analyst_score", "Score"],
                          ["entry_price", "Entry"],
                          ["exit_price", "Exit"],
                          ["return_pct", "Return"],
                          ["hold_days", "Hold"],
                          ["exit_reason", "Exit Reason"],
                        ] as [keyof TradeOutcome, string][]).map(([col, label]) => (
                          <th key={col} onClick={() => toggleSort(col)} style={thStyle}>
                            {label} {sortCol === col ? (sortAsc ? "↑" : "↓") : ""}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedTrades.map((t, i) => {
                        const win = t.return_pct > 0;
                        return (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}44` }}>
                            <td style={{ padding: "6px 10px", fontWeight: 700 }}>{t.symbol}</td>
                            <td style={{ padding: "6px 10px", color: T.sub }}>{t.signal_date}</td>
                            <td style={{ padding: "6px 10px", color: T.accent }}>{t.analyst_score}</td>
                            <td style={{ padding: "6px 10px" }}>{result.currency ?? "$"}{t.entry_price.toFixed(2)}</td>
                            <td style={{ padding: "6px 10px" }}>{result.currency ?? "$"}{t.exit_price.toFixed(2)}</td>
                            <td style={{ padding: "6px 10px", fontWeight: 700, color: win ? T.green : T.red }}>
                              {pct(t.return_pct)}
                            </td>
                            <td style={{ padding: "6px 10px", color: T.sub }}>{t.hold_days}d</td>
                            <td style={{ padding: "6px 10px" }}>
                              <span style={{
                                fontSize: "10px", padding: "2px 8px", borderRadius: "4px",
                                background: t.exit_reason === "target" ? T.greenBg : t.exit_reason === "stop" ? T.redBg : T.amberBg,
                                color: t.exit_reason === "target" ? T.green : t.exit_reason === "stop" ? T.red : T.amber,
                              }}>
                                {t.exit_reason}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Optimize button — only if gate failed */}
            {!result.gate_pass && (
              <div style={{ marginTop: "16px", background: T.amberBg, border: `1px solid ${T.amber}30`, borderRadius: "12px", padding: "16px 20px" }}>
                <div style={{ fontSize: "13px", color: T.amber, fontWeight: 600, marginBottom: "6px" }}>Gate failed — want AI to suggest better parameters?</div>
                <div style={{ fontSize: "12px", color: T.sub, marginBottom: "12px" }}>Sends metrics to Claude Haiku → diagnoses failures → runs 3 parameter variations → shows before/after comparison.</div>
                <button
                  onClick={runOptimize}
                  disabled={optimizing}
                  style={{ background: T.amber, border: "none", borderRadius: "8px", color: "#000", padding: "10px 24px", fontSize: "13px", fontWeight: 700, cursor: optimizing ? "not-allowed" : "pointer", opacity: optimizing ? 0.7 : 1 }}
                >
                  {optimizing ? "⏳ Optimizing… (runs 3 backtests)" : "✦ Auto-Optimize Params"}
                </button>
              </div>
            )}

            {/* Optimizer results */}
            {optimizeResult && (
              <div style={{ marginTop: "16px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px" }}>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "14px" }}>
                  {optimizeResult.status === "already_passing" ? "Already Passing" : "Optimizer Results — 3 Variations"}
                </div>

                {optimizeResult.status === "already_passing" ? (
                  <div style={{ color: T.green, fontSize: "13px" }}>✅ {optimizeResult.message}</div>
                ) : (
                  <>
                    {optimizeResult.best_suggestion && (
                      <div style={{ background: T.greenBg, border: `1px solid ${T.green}30`, borderRadius: "8px", padding: "12px 14px", marginBottom: "14px" }}>
                        <div style={{ fontSize: "11px", color: T.green, fontWeight: 700, marginBottom: "4px" }}>BEST VARIATION: {optimizeResult.best_suggestion.label}</div>
                        <div style={{ fontSize: "12px", color: T.sub }}>{optimizeResult.best_suggestion.rationale}</div>
                        {optimizeResult.best_suggestion.metrics && (
                          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", marginTop: "8px" }}>
                            {[
                              { l: "Gate", v: optimizeResult.best_suggestion.metrics.gate_pass ? "✅ PASS" : "❌ FAIL", c: optimizeResult.best_suggestion.metrics.gate_pass ? T.green : T.red },
                              { l: "Sharpe", v: optimizeResult.best_suggestion.metrics.sharpe_ratio.toFixed(2), c: T.text },
                              { l: "Win Rate", v: `${(optimizeResult.best_suggestion.metrics.win_rate * 100).toFixed(1)}%`, c: T.text },
                              { l: "Expectancy", v: pct(optimizeResult.best_suggestion.metrics.expectancy), c: T.text },
                            ].map(({ l, v, c }) => (
                              <div key={l} style={{ background: T.surface, borderRadius: "6px", padding: "6px 12px" }}>
                                <div style={{ fontSize: "9px", color: T.muted }}>{l}</div>
                                <div style={{ fontSize: "13px", fontWeight: 700, color: c }}>{v}</div>
                              </div>
                            ))}
                          </div>
                        )}
                        {optimizeResult.best_suggestion.params && (
                          <button
                            onClick={() => {
                              const p = optimizeResult.best_suggestion.params;
                              setForm(f => ({ ...f, score_threshold: p.score_threshold ?? f.score_threshold, target_pct: p.target_pct ?? f.target_pct, stop_loss_pct: p.stop_loss_pct ?? f.stop_loss_pct, max_hold_days: p.max_hold_days ?? f.max_hold_days }));
                              setOptimizeResult(null);
                              setResult(null);
                            }}
                            style={{ marginTop: "10px", background: T.green, border: "none", borderRadius: "6px", color: "#000", padding: "7px 18px", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}
                          >
                            Apply these params → Re-run
                          </button>
                        )}
                      </div>
                    )}

                    <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                      {(optimizeResult.suggestions ?? []).map((s: any, i: number) => (
                        <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px 14px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                            <span style={{ fontSize: "13px", fontWeight: 600, color: T.text }}>{s.label}</span>
                            {s.metrics && (
                              <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "20px", background: s.metrics.gate_pass ? T.greenBg : T.redBg, color: s.metrics.gate_pass ? T.green : T.red }}>
                                {s.metrics.gate_pass ? "✓ GATE PASS" : "✗ GATE FAIL"}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: "12px", color: T.sub, marginBottom: "8px" }}>{s.rationale}</div>
                          {s.params && (
                            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "6px" }}>
                              {Object.entries(s.params as Record<string, any>).filter(([k]) => ["score_threshold","target_pct","stop_loss_pct","max_hold_days"].includes(k)).map(([k, v]) => (
                                <span key={k} style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "4px", background: `${T.accent}15`, color: T.accent }}>
                                  {k.replace(/_/g, " ")}={v}
                                </span>
                              ))}
                            </div>
                          )}
                          {s.improvement && (
                            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                              {[
                                { l: "Sharpe Δ", v: `${s.improvement.sharpe_delta >= 0 ? "+" : ""}${s.improvement.sharpe_delta}`, pos: s.improvement.sharpe_delta > 0 },
                                { l: "Win Rate Δ", v: `${s.improvement.win_rate_delta >= 0 ? "+" : ""}${s.improvement.win_rate_delta}%`, pos: s.improvement.win_rate_delta > 0 },
                                { l: "Expectancy Δ", v: `${s.improvement.expectancy_delta >= 0 ? "+" : ""}${s.improvement.expectancy_delta}%`, pos: s.improvement.expectancy_delta > 0 },
                                { l: "Drawdown Δ", v: `${s.improvement.drawdown_delta >= 0 ? "-" : "+"}${Math.abs(s.improvement.drawdown_delta)}%`, pos: s.improvement.drawdown_delta > 0 },
                              ].map(({ l, v, pos }) => (
                                <span key={l} style={{ fontSize: "11px", color: pos ? T.green : T.red }}>
                                  {l}: {v}
                                </span>
                              ))}
                            </div>
                          )}
                          {s.error && <div style={{ fontSize: "11px", color: T.red, marginTop: "4px" }}>Error: {s.error}</div>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
