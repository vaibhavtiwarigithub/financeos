"use client";
import { useState, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import AgentComparisonCard from "@/components/dashboard/AgentComparisonCard";
const SignalCharts = lazy(() => import("@/components/charts/SignalChartsWrapper"));
const StockModal = lazy(() => import("@/components/charts/StockModal"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};


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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function AgentsPage({ signals, weights, strategy, learningLog, paperPortfolio, paperPositions, paperTrades, paperPerf, agentRuns }: {
  signals: any[]; weights: any; strategy: any; learningLog: any[];
  paperPortfolio: any; paperPositions: any[]; paperTrades: any[]; paperPerf: any[];
  agentRuns?: Record<string, any[]>;
}) {
  const supabase = createClient();
  const router = useRouter();
  const [tradingEnabled, setTradingEnabled] = useState(strategy?.trading_enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [tab, setTab] = useState<"signals" | "paper" | "weights" | "log" | "architecture">("paper");
  const [minScore, setMinScore] = useState<number>(strategy?.min_analyst_score ?? 70);
  const [maxPos, setMaxPos] = useState<number>(strategy?.max_position_pct ?? 5);
  const [maxTrades, setMaxTrades] = useState<number>(strategy?.max_daily_trades ?? 3);
  const [configSaving, setConfigSaving] = useState(false);
  const [configToast, setConfigToast] = useState("");
  const [expandedRuns, setExpandedRuns] = useState<string | null>(null);

  async function saveStrategyConfig() {
    if (!strategy?.id) return;
    setConfigSaving(true);
    await supabase.from("strategy_config").update({
      min_analyst_score: minScore,
      max_position_pct: maxPos,
      max_daily_trades: maxTrades,
    } as any).eq("id", strategy.id);
    setConfigSaving(false);
    setConfigToast("Saved!");
    setTimeout(() => setConfigToast(""), 2000);
    router.refresh();
  }

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
          body: JSON.stringify({}),
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
                if (evt.type === "symbols") lines.push(`Batch: ${evt.symbols?.join(", ")} (${evt.symbols?.length} symbols)`);
                else if (evt.type === "progress") { const tag = evt.isHeld ? "[HELD]" : evt.isEtf ? "[ETF]" : "[SCAN]"; lines.push(`${tag} Analyzing ${evt.symbol}...`); }
                else if (evt.type === "result") lines.push(`✓ ${evt.symbol}: ${evt.direction?.toUpperCase()} score=${evt.analystScore} (${evt.source})`);
                else if (evt.type === "error") lines.push(`✗ ${evt.symbol}: ${evt.error?.slice(0, 80)}`);
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
        {AGENTS.map(a => {
          const runKey = a.id === "paper-trade" ? "paper_trader" : a.id;
          const runs = agentRuns?.[runKey] ?? [];
          const lastRun = runs[0];
          const isExpanded = expandedRuns === a.id;
          return (
            <div key={a.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px" }}>
              <div style={{ fontSize: "20px", marginBottom: "6px" }}>{a.icon}</div>
              <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "3px" }}>{a.label}</div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>{a.desc}</div>
              <button
                onClick={() => runAgent(a.id, a.apiPath)}
                disabled={!!running}
                style={{ width: "100%", padding: "7px", background: running === a.id ? T.border : T.accent + "18", border: `1px solid ${T.accent}35`, borderRadius: "7px", color: running === a.id ? T.muted : T.accent, fontSize: "12px", fontWeight: 600, cursor: running ? "default" : "pointer" }}
              >
                {running === a.id ? "Running..." : "▶ Run"}
              </button>
              {/* Run history */}
              <div style={{ marginTop: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "8px" }}>
                {lastRun ? (
                  <>
                    <div
                      onClick={() => setExpandedRuns(isExpanded ? null : a.id)}
                      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontSize: "11px", color: T.textSub }}
                    >
                      <span>
                        <span style={{ color: lastRun.status === "error" ? T.red : T.green }}>●</span>
                        {" "}{timeAgo(lastRun.started_at)}
                        {lastRun.symbols?.length ? ` — ${lastRun.symbols.slice(0,3).join(", ")}${lastRun.symbols.length > 3 ? ` +${lastRun.symbols.length - 3}` : ""}` : ""}
                      </span>
                      <span style={{ color: T.muted }}>{isExpanded ? "▲" : "▼"}</span>
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: "8px", display: "flex", flexDirection: "column", gap: "6px" }}>
                        {runs.map((r: any) => (
                          <div key={r.id} style={{ fontSize: "10px", color: T.muted, background: T.surface, borderRadius: "6px", padding: "6px 8px" }}>
                            <div style={{ display: "flex", justifyContent: "space-between" }}>
                              <span style={{ color: r.status === "error" ? T.red : r.status === "running" ? T.amber : T.green, fontWeight: 600 }}>{r.status.toUpperCase()}</span>
                              <span>{timeAgo(r.started_at)}</span>
                            </div>
                            {r.symbols?.length > 0 && <div style={{ marginTop: "2px", color: T.textSub }}>{r.symbols.join(", ")}</div>}
                            {r.result_summary && <div style={{ marginTop: "2px" }}>{r.result_summary}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ fontSize: "11px", color: T.muted }}>Never run</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Run result */}
      {runResult && (
        <div style={{ marginBottom: "16px", background: T.surface, border: `1px solid ${runResult.startsWith("Error") ? T.red : T.green}40`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px", color: runResult.startsWith("Error") ? T.red : T.green, whiteSpace: "pre-wrap", fontFamily: "monospace", maxHeight: "120px", overflowY: "auto" }}>
          {runResult}
        </div>
      )}

      {/* Agent A/B Comparison */}
      <div style={{ marginBottom: "20px" }}>
        <AgentComparisonCard />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px", background: T.surface, padding: "4px", borderRadius: "10px", width: "fit-content" }}>
        {([
          { key: "paper", label: "Paper Trades" },
          { key: "signals", label: `Signals (${signals.length})` },
          { key: "weights", label: "Weights" },
          { key: "log", label: "Learning Log" },
          { key: "architecture", label: "Architecture" },
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
              <div style={{ fontWeight: 600, fontSize: "14px" }}>Strategy Config</div>
              {configToast && <span style={{ fontSize: "12px", color: T.green }}>{configToast}</span>}
            </div>
            {strategy ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: T.textSub }}>Mode</span>
                  <span style={{ fontWeight: 500 }}>{strategy.mode}</span>
                </div>
                {[
                  { label: "Min score to trade", val: minScore, set: setMinScore, min: 0, max: 100 },
                  { label: "Max position %", val: maxPos, set: setMaxPos, min: 1, max: 25 },
                  { label: "Max trades/day", val: maxTrades, set: setMaxTrades, min: 1, max: 10 },
                ].map(f => (
                  <div key={f.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px" }}>
                    <span style={{ color: T.textSub }}>{f.label}</span>
                    <input
                      type="number"
                      value={f.val}
                      min={f.min}
                      max={f.max}
                      onChange={e => f.set(Number(e.target.value))}
                      style={{ width: "64px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "13px", padding: "4px 8px", outline: "none", textAlign: "right" }}
                    />
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "13px" }}>
                  <span style={{ color: T.textSub }}>Target accuracy</span>
                  <span style={{ fontWeight: 500 }}>{(strategy.target_30d_accuracy * 100).toFixed(0)}%</span>
                </div>
                <button
                  onClick={saveStrategyConfig}
                  disabled={configSaving}
                  style={{ marginTop: "4px", width: "100%", padding: "8px", background: T.accent, border: "none", borderRadius: "8px", color: "#fff", fontSize: "12px", fontWeight: 600, cursor: configSaving ? "not-allowed" : "pointer", opacity: configSaving ? 0.7 : 1 }}
                >
                  {configSaving ? "Saving..." : "Save Config"}
                </button>
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

      {/* Architecture tab */}
      {tab === "architecture" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>

          {/* Section 1: Agent Pipeline */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 1</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Agent Pipeline</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

              {/* ResearchAgent */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🔍</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>ResearchAgent</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Weekdays 9 AM</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>
                  Gathers symbols from two sources:
                </div>
                <div style={{ marginTop: "10px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ fontSize: "13px", color: T.textSub, paddingLeft: "12px", borderLeft: `2px solid ${T.accent}` }}>
                    <span style={{ fontWeight: 600, color: T.text }}>1. Live Robinhood holdings</span> — account ••••8641 (read-only). These are highest priority — agent can output SELL signals on owned positions.
                  </div>
                  <div style={{ fontSize: "13px", color: T.textSub, paddingLeft: "12px", borderLeft: `2px solid ${T.green}` }}>
                    <span style={{ fontWeight: 600, color: T.text }}>2. Dual-bucket screener</span> — top 3 candidates/day:
                    <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "4px", paddingLeft: "12px" }}>
                      <div><span style={{ color: T.amber, fontWeight: 600 }}>Momentum:</span> RSI &gt; 60, price &gt; 50-day MA, revenue acceleration, positive earnings revision</div>
                      <div><span style={{ color: T.green, fontWeight: 600 }}>Value:</span> P/E &lt; sector median, FCF yield, insider buying, analyst upgrades</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* PaperTrader */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>📄</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>PaperTrader</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Auto-chained after Research</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Takes <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>agent_signals</code> with <strong style={{ color: T.text }}>score &ge; 60</strong> and <strong style={{ color: T.text }}>direction = "long"</strong>.</div>
                  <div>Sizes positions at <strong style={{ color: T.text }}>10% of paper NAV</strong> ($10k). Fetches real fill price from Robinhood.</div>
                  <div>Long-only enforcement — no short positions on screener candidates.</div>
                </div>
              </div>

              {/* LearnerAgent */}
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "18px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                  <span style={{ fontSize: "18px" }}>🧠</span>
                  <span style={{ fontWeight: 700, fontSize: "14px" }}>LearnerAgent</span>
                  <span style={{ fontSize: "11px", color: T.muted, background: T.card, border: `1px solid ${T.border}`, borderRadius: "4px", padding: "2px 8px" }}>Sundays 8 PM</span>
                </div>
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", display: "flex", flexDirection: "column", gap: "4px" }}>
                  <div>Closes paper trades older than 7 days. Calculates realized P&L vs benchmark.</div>
                  <div>Writes 1-sentence outcome note per trade + batch summary to <code style={{ background: T.card, padding: "1px 5px", borderRadius: "3px", fontSize: "12px", color: T.accent }}>learning_log</code>.</div>
                  <div><span style={{ color: T.amber, fontWeight: 600 }}>Phase 0:</span> records outcomes only — weight mutation locked until 10+ closed trades.</div>
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Data Sources */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 2</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Data Sources</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
              {[
                {
                  name: "FinancialDatasets MCP",
                  icon: "📊",
                  used: "Fundamentals: PE, revenue, FCF, earnings, insider trades, institutional holdings",
                },
                {
                  name: "Alpha Vantage MCP",
                  icon: "📈",
                  used: "Technicals: RSI, EMA(50), news sentiment, earnings calendar",
                },
                {
                  name: "Robinhood MCP",
                  icon: "🏦",
                  used: "Live quotes (fill prices), equity positions, order placement",
                },
              ].map(src => (
                <div key={src.name} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px" }}>
                  <div style={{ fontSize: "22px", marginBottom: "8px" }}>{src.icon}</div>
                  <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "6px" }}>{src.name}</div>
                  <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{src.used}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Section 3: Scoring Formula */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 3</div>
            <div style={{ fontWeight: 700, fontSize: "16px", marginBottom: "20px" }}>Scoring Formula</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px", color: T.textSub }}>analyst_score (0–100)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontWeight: 600, fontSize: "12px", color: T.text, marginBottom: "6px" }}>Stocks</div>
                    {["Fundamentals (PE, revenue growth, FCF yield)", "Technicals (RSI, EMA crossover)", "News sentiment", "Insider activity", "Earnings revision"].map(item => (
                      <div key={item} style={{ fontSize: "12px", color: T.textSub, display: "flex", alignItems: "flex-start", gap: "6px", marginTop: "4px" }}>
                        <span style={{ color: T.accent, flexShrink: 0, marginTop: "1px" }}>+</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "12px" }}>
                    <div style={{ fontWeight: 600, fontSize: "12px", color: T.text, marginBottom: "6px" }}>ETFs</div>
                    {["Macro/sector momentum", "RSI/EMA crossover", "No fundamentals — ETFs don't have PE/FCF"].map(item => (
                      <div key={item} style={{ fontSize: "12px", color: T.textSub, display: "flex", alignItems: "flex-start", gap: "6px", marginTop: "4px" }}>
                        <span style={{ color: T.green, flexShrink: 0, marginTop: "1px" }}>+</span>
                        <span>{item}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "10px", color: T.textSub }}>Action Thresholds</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {[
                    { range: "0 – 59", label: "No action", color: T.muted, bg: T.surface },
                    { range: "60 – 69", label: "PaperTrader fills paper trade", color: T.amber, bg: T.amberBg },
                    { range: "70+", label: "High conviction long", color: T.green, bg: T.greenBg },
                  ].map(t => (
                    <div key={t.range} style={{ background: t.bg, border: `1px solid ${t.color}30`, borderRadius: "8px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 700, fontSize: "14px", color: t.color, fontFamily: "monospace" }}>{t.range}</span>
                      <span style={{ fontSize: "12px", color: t.color }}>{t.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Section 4: Phase 0 Constraints */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Section 4</div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "20px" }}>
              <div style={{ fontWeight: 700, fontSize: "16px" }}>Phase 0 Constraints</div>
              <span style={{ fontSize: "11px", fontWeight: 600, padding: "3px 10px", borderRadius: "20px", background: T.amberBg, color: T.amber, border: `1px solid ${T.amber}40` }}>LOCKED</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "10px" }}>
              {[
                { icon: "🔒", label: "Long-only", detail: "Only BUY signals — no shorts on screener candidates" },
                { icon: "✅", label: "approval_required", detail: "All real trades need manual approval before execution" },
                { icon: "3️⃣", label: "Max 3 screener candidates/day", detail: "With $10k NAV and 10% sizing, max 10 positions total" },
                { icon: "⏳", label: "Weight mutation locked", detail: "Phase 1 unlocks only after 10+ closed paper trades" },
                { icon: "⚡", label: "TraderAgent account", detail: "Order placement only on agentic account ••••0660" },
                { icon: "🌊", label: "No explicit regime detection", detail: "Scoring adapts naturally — no bull/bear mode switching" },
              ].map(c => (
                <div key={c.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px", display: "flex", gap: "12px", alignItems: "flex-start" }}>
                  <span style={{ fontSize: "16px", flexShrink: 0 }}>{c.icon}</span>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", marginBottom: "3px" }}>{c.label}</div>
                    <div style={{ fontSize: "12px", color: T.textSub }}>{c.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}
