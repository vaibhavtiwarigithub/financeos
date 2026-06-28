"use client";
import { useState, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
const SignalCharts = lazy(() => import("@/components/charts/SignalChartsWrapper"));
const StockModal = lazy(() => import("@/components/charts/StockModal"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

const DEFAULT_WATCHLIST = ["AAPL", "NVDA", "TSLA", "MSFT", "META"];

const AGENTS = [
  { id: "research",    label: "ResearchAgent",  icon: "🔍", desc: "Analyzes stocks, writes signals",     apiPath: "/api/agents/research" },
  { id: "paper-trade", label: "PaperTrader",    icon: "📄", desc: "Shadow-trades signals on $10k virtual", apiPath: "/api/agents/paper-trade" },
  { id: "trader",      label: "TraderAgent",    icon: "⚡", desc: "Proposes real trades for approval",   apiPath: "/api/agents/trade" },
  { id: "learner",     label: "LearnerAgent",   icon: "🧠", desc: "Closes paper trades, adjusts weights", apiPath: "/api/agents/learner" },
];

function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }
function fmt(n: number) { return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

function dirBadge(d: string) {
  const up = d === "long" || d === "buy";
  return <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: up ? T.greenBg : T.redBg, color: up ? T.green : T.red }}>{d.toUpperCase()}</span>;
}

export default function AgentsPage({ signals, weights, strategy, learningLog, paperPortfolio, paperPositions, paperTrades, paperPerf }: {
  signals: any[]; weights: any; strategy: any; learningLog: any[];
  paperPortfolio: any; paperPositions: any[]; paperTrades: any[]; paperPerf: any[];
}) {
  const supabase = createClient();
  const router = useRouter();
  const [tradingEnabled, setTradingEnabled] = useState(strategy?.trading_enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<"signals" | "paper" | "weights" | "log">("paper");

  async function toggleTrading() {
    setSaving(true);
    const next = !tradingEnabled;
    await supabase.from("strategy_config").update({ trading_enabled: next }).eq("id", strategy?.id);
    setTradingEnabled(next);
    setSaving(false);
  }

  async function runAgent(id: string, apiPath: string | null) {
    if (!apiPath) { setRunResult("Not yet implemented."); return; }
    setRunning(id);
    setRunResult(null);

    if (id === "research") {
      // SSE streaming: show per-symbol progress live
      try {
        const res = await fetch(apiPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbols: DEFAULT_WATCHLIST }),
        });
        if (!res.ok || !res.body) {
          setRunResult(`Error: HTTP ${res.status}`);
          setRunning(null);
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        const lines: string[] = [];
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() ?? "";
          for (const chunk of parts) {
            for (const line of chunk.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "progress") lines.push(`Analyzing ${evt.symbol}...`);
                else if (evt.type === "result") lines.push(`${evt.symbol}: ${evt.direction?.toUpperCase()} score=${evt.analystScore} conviction=${evt.conviction}`);
                else if (evt.type === "error") lines.push(`${evt.symbol}: ERROR — ${evt.error}`);
                else if (evt.type === "done") { lines.push(`Done — ${evt.processed} symbol(s).`); router.refresh(); }
                setRunResult(lines.join("\n"));
              } catch {}
            }
          }
        }
      } catch (e: any) {
        setRunResult("Error: " + e.message);
      }
      setRunning(null);
      return;
    }

    // All other agents: normal JSON POST
    try {
      const res = await fetch(apiPath, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.error) {
        setRunResult(`Error: ${data.error}${data.detail ? "\n" + data.detail : ""}`);
      } else if (data.skipped) {
        setRunResult("Skipped: " + data.reason);
      } else {
        const count = data.processed ?? data.filled ?? data.closed ?? data.queued ?? 0;
        const errs = (data.results ?? []).filter((r: any) => r.error);
        const errDetail = errs.length ? `\n${errs.map((r: any) => `${r.symbol}: ${r.error}`).join("\n")}` : "";
        setRunResult(`Done — ${count} result(s).${errDetail}`);
        router.refresh();
      }
    } catch (e: any) {
      setRunResult("Error: " + e.message);
    }
    setRunning(null);
  }

  // Paper stats
  const startingNAV = 10000;
  const currentNAV = paperPortfolio?.nav ?? startingNAV;
  const totalPnl = currentNAV - startingNAV;
  const totalPnlPct = (totalPnl / startingNAV) * 100;
  const closedTrades = paperTrades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.outcome === "win").length;
  const losses = closedTrades.filter(t => t.outcome === "loss").length;
  const winRate = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : 0;
  const pendingSignals = signals.filter(s => s.status === "pending").length;

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Agent Control Center</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>AI Agents</h1>
          <button
            onClick={toggleTrading}
            disabled={saving}
            style={{ padding: "10px 22px", borderRadius: "10px", fontWeight: 700, fontSize: "13px", cursor: saving ? "default" : "pointer", border: `1px solid ${tradingEnabled ? T.green : T.red}40`, background: tradingEnabled ? "#34D39922" : "#F8717122", color: tradingEnabled ? T.green : T.red } as any}
          >
            {saving ? "..." : tradingEnabled ? "⚡ Live Trading ON — Kill Switch" : "🔴 Live Trading PAUSED — Enable"}
          </button>
        </div>
      </div>

      {/* Paper portfolio hero */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "24px", marginBottom: "20px", display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "24px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Paper NAV</div>
          <div style={{ fontSize: "24px", fontWeight: 700 }}>${currentNAV.toFixed(0)}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>started $10,000</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Total P&L</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: pnlColor(totalPnl) }}>{fmt(totalPnl)}</div>
          <div style={{ fontSize: "12px", color: pnlColor(totalPnlPct) }}>{fmtPct(totalPnlPct)}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Cash</div>
          <div style={{ fontSize: "24px", fontWeight: 700 }}>${(paperPortfolio?.cash_balance ?? 10000).toFixed(0)}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>{paperPositions.length} position{paperPositions.length !== 1 ? "s" : ""}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Win Rate</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: winRate >= 60 ? T.green : winRate >= 40 ? T.amber : T.red }}>{closedTrades.length ? winRate + "%" : "—"}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>{wins}W / {losses}L of {closedTrades.length}</div>
        </div>
        <div>
          <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Pending Signals</div>
          <div style={{ fontSize: "24px", fontWeight: 700, color: pendingSignals > 0 ? T.amber : T.muted }}>{pendingSignals}</div>
          <div style={{ fontSize: "12px", color: T.muted }}>awaiting agents</div>
        </div>
      </div>

      {/* Agent runner cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px", marginBottom: "20px" }}>
        {AGENTS.map(a => (
          <div key={a.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px" }}>
            <div style={{ fontSize: "20px", marginBottom: "6px" }}>{a.icon}</div>
            <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "3px" }}>{a.label}</div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "12px" }}>{a.desc}</div>
            <button
              onClick={() => runAgent(a.id, a.apiPath)}
              disabled={!!running}
              style={{ width: "100%", padding: "7px", background: running === a.id ? T.border : T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: "7px", color: running === a.id ? T.muted : T.accent, fontSize: "12px", fontWeight: 600, cursor: running ? "default" : "pointer" }}
            >
              {running === a.id ? "Running..." : "▶ Run"}
            </button>
          </div>
        ))}
      </div>

      {/* Run result */}
      {runResult && (
        <div style={{ marginBottom: "16px", background: T.surface, border: `1px solid ${runResult.startsWith("Error") ? T.red : T.green}40`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: runResult.startsWith("Error") ? T.red : T.green, whiteSpace: "pre-wrap", fontFamily: "monospace", maxHeight: "120px", overflowY: "auto" }}>
          {runResult}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: T.surface, padding: "4px", borderRadius: "10px", width: "fit-content" }}>
        {([
          { key: "paper", label: "Paper Trades" },
          { key: "signals", label: `Signals (${signals.length})` },
          { key: "weights", label: "Weights" },
          { key: "log", label: "Learning Log" },
        ] as const).map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "7px 16px", borderRadius: "7px", border: "none", cursor: "pointer", fontSize: "12px", fontWeight: 500, background: tab === t.key ? T.card : "transparent", color: tab === t.key ? T.text : T.muted }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Paper trades tab */}
      {tab === "paper" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Open positions */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Open Positions</div>
            {paperPositions.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No open positions. Run PaperTrader to start shadow trading.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Qty", "Avg Cost", "Current", "P&L", "P&L %"].map(h => (
                      <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paperPositions.map(p => {
                    const pnl = (p.current_price - p.avg_cost) * p.qty;
                    const pnlPct = ((p.current_price - p.avg_cost) / p.avg_cost) * 100;
                    return (
                      <tr key={p.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>{p.symbol}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>{p.qty}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>${p.avg_cost.toFixed(2)}</td>
                        <td style={{ padding: "9px 12px 9px 0" }}>{p.current_price ? "$" + p.current_price.toFixed(2) : "—"}</td>
                        <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: pnlColor(pnl) }}>{fmt(pnl)}</td>
                        <td style={{ padding: "9px 0", color: pnlColor(pnlPct) }}>{fmtPct(pnlPct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>


          {/* Closed trades */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Trade History</div>
            {paperTrades.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "20px 0" }}>No paper trades yet.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Side", "Qty", "Entry", "Exit", "P&L", "Outcome", "Date"].map(h => (
                      <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paperTrades.map(t => (
                    <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "9px 12px 9px 0", fontWeight: 700 }}>{t.symbol}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{dirBadge(t.order_side)}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{t.qty}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>${t.fill_price?.toFixed(2)}</td>
                      <td style={{ padding: "9px 12px 9px 0" }}>{t.exit_price ? "$" + t.exit_price.toFixed(2) : <span style={{ color: T.amber }}>Open</span>}</td>
                      <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: t.realized_pnl != null ? pnlColor(t.realized_pnl) : T.muted }}>
                        {t.realized_pnl != null ? fmt(t.realized_pnl) : "—"}
                      </td>
                      <td style={{ padding: "9px 12px 9px 0" }}>
                        {t.outcome ? (
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 8px", borderRadius: "4px", background: t.outcome === "win" ? T.greenBg : t.outcome === "loss" ? T.redBg : T.amberBg, color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.amber }}>
                            {t.outcome}
                          </span>
                        ) : <span style={{ color: T.amber, fontSize: "11px" }}>open</span>}
                      </td>
                      <td style={{ padding: "9px 0", color: T.muted, fontSize: "11px" }}>{new Date(t.executed_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* Signals tab */}
      {tab === "signals" && (
        <>
          {signals.length > 0 && (
            <Suspense fallback={null}>
              <SignalCharts signals={signals} />
            </Suspense>
          )}
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {signals.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No signals yet. Run ResearchAgent first.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Direction", "Score", "Status", "Rationale", "Date"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 8px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map(s => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "9px 12px 9px 0", fontWeight: 700, cursor: "pointer", color: T.accent }} onClick={() => setChartSymbol(s.symbol)}>{s.symbol} ↗</td>
                    <td style={{ padding: "9px 12px 9px 0" }}>{dirBadge(s.direction)}</td>
                    <td style={{ padding: "9px 12px 9px 0", fontWeight: 600, color: (s.analyst_score ?? 0) >= 75 ? T.green : (s.analyst_score ?? 0) >= 50 ? T.amber : T.red }}>{s.analyst_score ?? "—"}</td>
                    <td style={{ padding: "9px 12px 9px 0" }}>
                      <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: s.status === "paper_traded" ? T.greenBg : s.status === "pending" ? T.amberBg : T.border, color: s.status === "paper_traded" ? T.green : s.status === "pending" ? T.amber : T.muted }}>
                        {s.status}
                      </span>
                    </td>
                    <td style={{ padding: "9px 12px 9px 0", color: T.textSub, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.rationale ?? "—"}</td>
                    <td style={{ padding: "9px 0", color: T.muted, fontSize: "11px" }}>{s.created_at ? new Date(s.created_at).toLocaleDateString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {chartSymbol && (
          <Suspense fallback={null}>
            <StockModal symbol={chartSymbol} onClose={() => setChartSymbol(null)} />
          </Suspense>
        )}
        </>
      )}

      {/* Weights tab */}
      {tab === "weights" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "16px" }}>Signal Weights</div>
            {weights ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {[
                  { label: "Fundamental", key: "fundamental_weight" },
                  { label: "Technical", key: "technical_weight" },
                  { label: "Sentiment", key: "sentiment_weight" },
                  { label: "Macro", key: "macro_weight" },
                  { label: "Insider", key: "insider_weight" },
                ].map(w => {
                  const val = Math.round((weights[w.key] ?? 0) * 100);
                  return (
                    <div key={w.key}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px" }}>
                        <span style={{ fontSize: "13px", color: T.textSub }}>{w.label}</span>
                        <span style={{ fontSize: "13px", fontWeight: 600, color: T.accent }}>{val}%</span>
                      </div>
                      <div style={{ height: "4px", background: T.border, borderRadius: "2px" }}>
                        <div style={{ height: "4px", borderRadius: "2px", background: T.accent, width: `${val}%`, transition: "width 0.3s" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : <div style={{ color: T.muted, fontSize: "13px" }}>No weights yet.</div>}
          </div>

          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "16px" }}>Strategy Config</div>
            {strategy ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {[
                  { label: "Mode", value: strategy.mode },
                  { label: "Max position", value: strategy.max_position_pct + "%" },
                  { label: "Max trades/day", value: strategy.max_daily_trades },
                  { label: "Min score to trade", value: strategy.min_analyst_score },
                  { label: "Target accuracy", value: (strategy.target_30d_accuracy * 100).toFixed(0) + "%" },
                  { label: "Max drawdown", value: strategy.max_drawdown_pct + "%" },
                ].map(r => (
                  <div key={r.label} style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                    <span style={{ color: T.textSub }}>{r.label}</span>
                    <span style={{ fontWeight: 500 }}>{r.value}</span>
                  </div>
                ))}
              </div>
            ) : <div style={{ color: T.muted, fontSize: "13px" }}>No config.</div>}
          </div>
        </div>
      )}

      {/* Learning log tab */}
      {tab === "log" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "14px" }}>Learning Log</div>
          {learningLog.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>
              No learning events yet. LearnerAgent closes paper trades after 7 days and adjusts weights.
            </div>
          ) : learningLog.map(l => (
            <div key={l.id} style={{ borderTop: `1px solid ${T.border}`, padding: "12px 0" }}>
              <div style={{ fontSize: "13px" }}>{l.note}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>{new Date(l.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
