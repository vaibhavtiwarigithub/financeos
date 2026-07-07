"use client";
import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
const StockModal = lazy(() => import("@/components/charts/StockModal"));
import PageHeader from "@/components/dashboard/PageHeader";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function fmt(n: number) { return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }

// ── Paper Performance Panel ──────────────────────────────────────────────────

interface PerfData {
  navHistory: { date: string; nav: number }[];
  trades: any[];
  winRate: number;
  avgReturn: number;
  totalPnl: number;
  spyReturn: number;
  paperReturn: number;
  closedCount: number;
  gates: { minTrades: boolean; winRate: boolean; positiveReturn: boolean; beatsSpy: boolean };
  allGatesPassed: boolean;
  nav: number;
  cash: number;
}

function NavChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "6px" }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color, fontWeight: 600, marginBottom: "2px" }}>
          {p.name}: ${Number(p.value).toFixed(0)}
        </div>
      ))}
    </div>
  );
}

function PaperPerformancePanel({ strategy }: { strategy: any }) {
  const [perf, setPerf] = useState<PerfData | null>(null);
  const [loading, setLoading] = useState(true);
  const [snapshotting, setSnapshotting] = useState(false);
  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null);
  const [enablingLive, setEnablingLive] = useState(false);
  const router = useRouter();

  async function loadPerf() {
    setLoading(true);
    try {
      const res = await fetch("/api/agents/performance");
      const data = await res.json();
      setPerf(data);
    } catch {
      // silently ignore
    }
    setLoading(false);
  }

  useEffect(() => { loadPerf(); }, []);

  async function snapshotNav() {
    setSnapshotting(true);
    setSnapshotMsg(null);
    try {
      const res = await fetch("/api/agents/performance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snapshot" }),
      });
      const data = await res.json();
      if (data.snapshotted) {
        setSnapshotMsg(`Snapshotted NAV $${Number(data.nav).toFixed(0)} for ${data.date}`);
        await loadPerf();
      } else {
        setSnapshotMsg(data.error ?? "Snapshot failed");
      }
    } catch (e: any) {
      setSnapshotMsg("Error: " + e.message);
    }
    setSnapshotting(false);
  }

  async function enableLiveTrading() {
    if (!strategy?.id) return;
    setEnablingLive(true);
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      await supabase.from("strategy_config").update({ trading_enabled: true }).eq("id", strategy.id);
      router.refresh();
    } catch {
      // silently ignore
    }
    setEnablingLive(false);
  }

  if (loading) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "24px", marginBottom: "20px" }}>
        <div style={{ color: T.muted, fontSize: "13px" }}>Loading performance data…</div>
      </div>
    );
  }

  if (!perf) return null;

  const { navHistory, winRate, avgReturn, totalPnl, spyReturn, paperReturn, closedCount, gates, allGatesPassed } = perf;
  const tradingActive = strategy?.trading_enabled === true;

  // Build chart data: paper NAV + SPY rescaled to $10,000 start
  const firstNav = navHistory.length > 0 ? navHistory[0].nav : 10000;
  const spyBase = firstNav; // SPY rescaled to same start
  // We only have nav history here — SPY line uses the spyReturn we have (linear interpolation as proxy)
  // Build a two-line dataset: paper line from navHistory, SPY estimated line
  const chartData = navHistory.map((row, i) => {
    // SPY line: linear interpolation from base to final spyReturn over the history window
    const progress = navHistory.length > 1 ? i / (navHistory.length - 1) : 0;
    const spyVal = spyBase * (1 + (spyReturn / 100) * progress);
    return {
      date: row.date,
      paper: Number(row.nav),
      spy: parseFloat(spyVal.toFixed(2)),
    };
  });

  const gateRows: { label: string; pass: boolean; detail: string }[] = [
    { label: "10+ closed paper trades", pass: gates.minTrades, detail: `(${closedCount} so far)` },
    { label: "Win rate ≥ 55%", pass: gates.winRate, detail: `(currently ${winRate.toFixed(1)}%)` },
    { label: "Net positive return", pass: gates.positiveReturn, detail: `(${paperReturn >= 0 ? "+" : ""}${paperReturn.toFixed(2)}%)` },
    { label: "Outperforming SPY", pass: gates.beatsSpy, detail: `(paper ${paperReturn >= 0 ? "+" : ""}${paperReturn.toFixed(2)}% vs SPY ${spyReturn >= 0 ? "+" : ""}${spyReturn.toFixed(2)}%)` },
  ];

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "24px", marginBottom: "20px" }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
        <div>
          <div style={{ fontSize: "14px", fontWeight: 700, color: T.text }}>Agent Performance · Paper Track Record</div>
          <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>
            {closedCount} closed trade{closedCount !== 1 ? "s" : ""} · gates must pass before live trading unlocks
          </div>
        </div>
        <button
          onClick={snapshotNav}
          disabled={snapshotting}
          style={{ padding: "8px 16px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.textSub, fontSize: "12px", fontWeight: 600, cursor: snapshotting ? "not-allowed" : "pointer" }}
        >
          {snapshotting ? "Snapshotting…" : "Snapshot NAV"}
        </button>
      </div>

      {snapshotMsg && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: snapshotMsg.startsWith("Error") ? T.red : T.green }}>
          {snapshotMsg}
        </div>
      )}

      {/* NAV Chart */}
      {chartData.length < 2 ? (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "40px", textAlign: "center", color: T.muted, fontSize: "13px", marginBottom: "20px" }}>
          Run paper trades to build history — snapshot NAV daily after each PaperTrader run
        </div>
      ) : (
        <div style={{ marginBottom: "20px" }}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: T.muted }}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
                tickFormatter={(d: string) => {
                  const dt = new Date(d);
                  return `${dt.getMonth() + 1}/${dt.getDate()}`;
                }}
              />
              <YAxis
                tick={{ fontSize: 10, fill: T.muted }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => "$" + v.toFixed(0)}
                width={56}
              />
              <RechartsTooltip content={<NavChartTooltip />} />
              <Line type="monotone" dataKey="paper" name="Paper NAV" stroke={T.accent} strokeWidth={2.5} dot={false} />
              <Line type="monotone" dataKey="spy" name="SPY (rescaled)" stroke={T.muted} strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", gap: "16px", justifyContent: "flex-end", fontSize: "11px", color: T.muted, marginTop: "6px" }}>
            <span><span style={{ color: T.accent, fontWeight: 700 }}>—</span> Paper NAV</span>
            <span><span style={{ color: T.muted }}>- -</span> SPY baseline</span>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "12px", marginBottom: "20px" }}>
        {[
          {
            label: "Win Rate",
            value: winRate.toFixed(1) + "%",
            color: winRate >= 55 ? T.green : T.red,
          },
          {
            label: "Avg Return",
            value: (avgReturn >= 0 ? "+" : "") + avgReturn.toFixed(2) + "%",
            color: avgReturn >= 0 ? T.green : T.red,
          },
          {
            label: "Total P&L",
            value: (totalPnl >= 0 ? "+$" : "-$") + Math.abs(totalPnl).toFixed(0),
            color: totalPnl >= 0 ? T.green : T.red,
          },
          {
            label: "vs SPY",
            value: (paperReturn - spyReturn >= 0 ? "+" : "") + (paperReturn - spyReturn).toFixed(2) + "%",
            color: paperReturn > spyReturn ? T.green : T.red,
          },
        ].map(s => (
          <div key={s.label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px" }}>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: "6px" }}>{s.label}</div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: s.color }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Gate checklist */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px", marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", fontWeight: 600, color: T.textSub, marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Live Trading Gates
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {gateRows.map(g => (
            <div key={g.label} style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: "13px" }}>
              <span style={{ fontSize: "15px" }}>{g.pass ? "✅" : "❌"}</span>
              <span style={{ color: g.pass ? T.text : T.muted }}>{g.label}</span>
              <span style={{ color: T.muted, fontSize: "12px" }}>{g.detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Enable Real Trading / Live badge */}
      {tradingActive ? (
        <div style={{ display: "flex", alignItems: "center", gap: "10px", padding: "12px 18px", background: "#052E16", border: `1px solid ${T.green}40`, borderRadius: "10px" }}>
          <span style={{ fontSize: "16px" }}>⚡</span>
          <span style={{ color: T.green, fontWeight: 700, fontSize: "14px" }}>LIVE TRADING ACTIVE</span>
          <span style={{ color: T.muted, fontSize: "12px", marginLeft: "auto" }}>Toggle off in Agents → Strategy Config</span>
        </div>
      ) : (
        <button
          onClick={allGatesPassed ? enableLiveTrading : undefined}
          disabled={!allGatesPassed || enablingLive}
          style={{
            width: "100%", padding: "14px", borderRadius: "10px", fontSize: "14px", fontWeight: 700,
            cursor: allGatesPassed ? "pointer" : "not-allowed",
            border: "none",
            background: allGatesPassed ? T.green : T.surface,
            color: allGatesPassed ? "#000" : T.muted,
            opacity: allGatesPassed ? 1 : 0.6,
            transition: "opacity 0.2s",
          }}
        >
          {enablingLive ? "Enabling…" : allGatesPassed ? "Enable Real Trading" : "Enable Real Trading (gates not yet passed)"}
        </button>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function ScoreBar({ score }: { score: number }) {
  const color = score >= 70 ? T.green : score >= 50 ? T.amber : T.red;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
      <div style={{ width: "80px", height: "5px", background: T.border, borderRadius: "3px", overflow: "hidden" }}>
        <div style={{ width: score + "%", height: "100%", background: color, borderRadius: "3px" }} />
      </div>
      <span style={{ fontSize: "12px", fontWeight: 700, color }}>{score}</span>
    </div>
  );
}

export default function TradingPage({ pendingSignals, tradeLog, strategy, portfolio, queue }: {
  pendingSignals: any[]; tradeLog: any[]; strategy: any; portfolio: any; queue: any[];
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [monitorRunning, setMonitorRunning] = useState(false);
  const [monitorResult, setMonitorResult] = useState<{ checked: number; closed: number; closedDetails: string[]; updated: number } | null>(null);
  const [tab, setTab] = useState<"queue" | "signals" | "history">("queue");
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<any[]>(queue);
  const [actionLog, setActionLog] = useState<{ id: string; msg: string; ok: boolean } | null>(null);

  async function approveTradeItem(tradeId: string) {
    setActionLog(null);
    const res = await fetch("/api/agents/trade/approve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId }),
    });
    const data = await res.json();
    setActionLog({ id: tradeId, msg: data.message ?? data.error ?? "Done", ok: !!data.success });
    setQueueItems(items => items.map(i => i.id === tradeId ? { ...i, status: "approved" } : i));
    router.refresh();
  }

  async function rejectTradeItem(tradeId: string) {
    setActionLog(null);
    const res = await fetch("/api/agents/trade/reject", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradeId, reason: "Rejected by user" }),
    });
    const data = await res.json();
    setActionLog({ id: tradeId, msg: data.message ?? data.error ?? "Done", ok: !!data.success });
    setQueueItems(items => items.filter(i => i.id !== tradeId));
    router.refresh();
  }

  const nav = portfolio?.nav ?? 10000;
  const cash = portfolio?.cash_balance ?? 10000;
  const pnl = nav - 10000;
  const longSignals = pendingSignals.filter(s => s.direction === "long" && s.analyst_score >= 60);

  async function runPositionMonitor() {
    setMonitorRunning(true);
    setMonitorResult(null);
    try {
      const res = await fetch("/api/agents/position-monitor", { method: "POST" });
      const data = await res.json();
      if (data.error) {
        setMonitorResult({ checked: 0, closed: 0, closedDetails: [`Error: ${data.error}`], updated: 0 });
      } else {
        setMonitorResult({ checked: data.checked ?? 0, closed: data.closed ?? 0, closedDetails: data.closedDetails ?? [], updated: data.updated ?? 0 });
        router.refresh();
      }
    } catch (e: any) {
      setMonitorResult({ checked: 0, closed: 0, closedDetails: [`Error: ${e.message}`], updated: 0 });
    }
    setMonitorRunning(false);
  }

  async function runPaperTrade() {
    setRunning(true);
    setRunLog(["Running PaperTrader..."]);
    try {
      const res = await fetch("/api/agents/paper-trade", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
      });
      const data = await res.json();
      if (data.skipped) {
        setRunLog(["Skipped: " + data.reason]);
      } else if (data.error) {
        setRunLog(["Error: " + data.error]);
      } else {
        const filled = data.trades ?? [];
        setRunLog([
          `Filled ${data.filled} trade(s), skipped ${data.skipped ?? 0}.`,
          ...filled.map((t: any) => `${t.symbol}: ${t.qty} shares @ $${t.fillPrice?.toFixed(2)} (${t.priceSource})`),
          `NAV: $${data.nav?.toFixed(0)}`,
        ]);
        router.refresh();
      }
    } catch (e: any) {
      setRunLog(["Error: " + e.message]);
    }
    setRunning(false);
  }

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <PageHeader
        title="Trading"
        subtitle="Paper trading · agent executes signals automatically"
        cadence="daily"
        whatItDoes="PaperTrader runs daily after ResearchAgent — buys if signal score ≥60, sells if score drops. All trades are paper (simulated) on the agentic Robinhood account. Real trading requires explicit enable."
        whatToLookFor={[
          "Score ≥60 = agent may enter. Score <40 on existing position = agent may exit.",
          "P&L is paper — no real money moves until Live Trading is explicitly enabled.",
          "Run PaperTrader manually to force a cycle right now with current signals.",
          "Live Trading toggle is a kill switch — off by default, enable only when ready.",
        ]}
        actions={[{ label: running ? "Running…" : "Run PaperTrader", onClick: runPaperTrade, primary: true }]}
      />
      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) 32px" }}>

      {/* Paper Performance Panel */}
      <PaperPerformancePanel strategy={strategy} />

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "16px", marginBottom: "20px" }}>
        {[
          { label: "Paper NAV", value: "$" + nav.toFixed(0), sub: pnl >= 0 ? "+" + pnl.toFixed(0) : "-" + Math.abs(pnl).toFixed(0), color: pnlColor(pnl) },
          { label: "Cash Available", value: "$" + cash.toFixed(0), sub: ((cash / nav) * 100).toFixed(1) + "% liquid" },
          { label: "Pending Signals", value: String(longSignals.length), sub: "score ≥ 60, direction = long", color: longSignals.length > 0 ? T.amber : T.muted },
          { label: "Mode", value: strategy?.mode ?? "paper", sub: "long-only, $10k virtual" },
        ].map(s => (
          <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px" }}>
            <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{s.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: s.color ?? T.text }}>{s.value}</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Run log */}
      {runLog.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "20px", fontFamily: "monospace", fontSize: "12px" }}>
          {runLog.map((l, i) => <div key={i} style={{ color: l.startsWith("Error") ? T.red : l.startsWith("Skipped") ? T.amber : T.green }}>{l}</div>)}
        </div>
      )}

      {/* Position Monitor */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 20px", marginBottom: "20px", display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: "160px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.text, marginBottom: "3px" }}>Position Monitor</div>
          <div style={{ fontSize: "12px", color: T.muted }}>
            {monitorResult
              ? `${monitorResult.checked} checked · ${monitorResult.closed} closed · ${monitorResult.updated} updated`
              : "Checks stop-loss and price targets on open positions. Run daily after market close."}
          </div>
          {monitorResult && monitorResult.closedDetails.length > 0 && (
            <div style={{ marginTop: "6px", fontSize: "11px", fontFamily: "monospace" }}>
              {monitorResult.closedDetails.map((d, i) => (
                <div key={i} style={{ color: d.startsWith("Error") ? T.red : T.amber }}>{d}</div>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={runPositionMonitor}
          disabled={monitorRunning}
          style={{ padding: "9px 18px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: monitorRunning ? T.muted : T.textSub, fontSize: "12px", fontWeight: 600, cursor: monitorRunning ? "not-allowed" : "pointer", whiteSpace: "nowrap" }}
        >
          {monitorRunning ? "Checking…" : "Run Position Monitor"}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px" }}>
        {(["queue", "signals", "history"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t === "queue" ? `Trade Queue (${queueItems.length})` : t === "signals" ? `Paper Signals (${pendingSignals.length})` : `Paper History (${tradeLog.length})`}
          </button>
        ))}
      </div>

      {/* Trade queue — real Robinhood approval flow */}
      {tab === "queue" && (
        <div>
          {actionLog && (
            <div style={{ background: T.surface, border: `1px solid ${actionLog.ok ? T.green : T.red}`, borderRadius: "10px", padding: "12px 16px", marginBottom: "16px", fontSize: "13px", color: actionLog.ok ? T.green : T.red }}>
              {actionLog.msg}
            </div>
          )}
          {queueItems.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
              No pending trades. Run TraderAgent from the Agents page to propose real Robinhood trades.
            </div>
          ) : queueItems.map((q: any) => (
            <div key={q.id} style={{ background: T.card, border: `1px solid ${q.status === "pending_approval" ? T.amber + "60" : T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "10px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "80px 1fr 1fr 1fr auto", gap: "12px", alignItems: "center" }}>
                <div style={{ fontWeight: 800, fontSize: "16px", color: T.accent, cursor: "pointer" }} onClick={() => setChartSymbol(q.symbol)}>
                  {q.symbol} ↗
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: T.muted, marginBottom: "3px" }}>ORDER</div>
                  <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: T.greenBg, color: T.green }}>
                    BUY {q.qty} shares
                  </span>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: T.muted, marginBottom: "3px" }}>LIMIT PRICE</div>
                  <span style={{ fontSize: "14px", fontWeight: 600 }}>${q.limit_price?.toFixed(2)}</span>
                </div>
                <div>
                  <div style={{ fontSize: "10px", color: T.muted, marginBottom: "3px" }}>SCORE / STATUS</div>
                  <span style={{ fontSize: "12px", color: T.accent, fontWeight: 600 }}>{q.analyst_score}/100</span>
                  <span style={{ fontSize: "11px", color: T.muted, marginLeft: "8px" }}>{q.status}</span>
                </div>
                {q.status === "pending_approval" ? (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button onClick={() => approveTradeItem(q.id)} style={{ padding: "8px 16px", background: T.green, border: "none", borderRadius: "7px", color: "#000", fontSize: "12px", fontWeight: 700, cursor: "pointer" }}>
                      Approve
                    </button>
                    <button onClick={() => rejectTradeItem(q.id)} style={{ padding: "8px 14px", background: T.redBg, border: `1px solid ${T.red}40`, borderRadius: "7px", color: T.red, fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
                      Reject
                    </button>
                  </div>
                ) : (
                  <span style={{ fontSize: "11px", color: T.green, fontWeight: 600 }}>Approved</span>
                )}
              </div>
              {q.rationale && (
                <div style={{ marginTop: "10px", fontSize: "13px", color: T.textSub, lineHeight: "1.6", whiteSpace: "pre-wrap", borderTop: `1px solid ${T.border}`, paddingTop: "10px" }}>
                  {q.rationale}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Signals */}
      {tab === "signals" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {pendingSignals.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
              No pending signals. Run ResearchAgent from the Agents page to generate signals.
            </div>
          ) : pendingSignals.map((s: any) => (
            <div key={s.id} style={{ background: T.card, border: `1px solid ${s.analyst_score >= 60 && s.direction === "long" ? T.accent + "44" : T.border}`, borderRadius: "12px", padding: "16px 20px", display: "grid", gridTemplateColumns: "80px 1fr 1fr 1fr 1fr", gap: "12px", alignItems: "center" }}>
              <div style={{ fontWeight: 800, fontSize: "16px", cursor: "pointer", color: T.accent }} onClick={() => setChartSymbol(s.symbol)}>{s.symbol} ↗</div>
              <div>
                <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>DIRECTION</div>
                <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: s.direction === "long" ? T.greenBg : T.amberBg, color: s.direction === "long" ? T.green : T.amber }}>
                  {s.direction?.toUpperCase()}
                </span>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>ANALYST SCORE</div>
                <ScoreBar score={s.analyst_score ?? 0} />
              </div>
              <div>
                <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>CONVICTION</div>
                <span style={{ fontSize: "14px", fontWeight: 600 }}>{s.conviction}/100</span>
              </div>
              <div>
                <div style={{ fontSize: "10px", color: T.muted, marginBottom: "4px" }}>QUALIFIES</div>
                {s.analyst_score >= 60 && s.direction === "long"
                  ? <span style={{ color: T.green, fontSize: "12px", fontWeight: 600 }}>Yes — will fill</span>
                  : <span style={{ color: T.muted, fontSize: "12px" }}>No ({s.analyst_score < 60 ? "score < 60" : "not long"})</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {chartSymbol && (
        <Suspense fallback={null}>
          <StockModal symbol={chartSymbol} onClose={() => setChartSymbol(null)} />
        </Suspense>
      )}

      {/* Trade history */}
      {tab === "history" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {tradeLog.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No paper trades yet.</div>
          ) : (
            <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Side", "Qty", "Fill", "Total", "Score", "Outcome", "Date"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tradeLog.map((t: any) => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{t.symbol}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: t.order_side === "buy" ? T.greenBg : T.redBg, color: t.order_side === "buy" ? T.green : T.red }}>
                        {t.order_side?.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>${t.fill_price?.toFixed(2)}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>${(t.qty * t.fill_price)?.toFixed(0)}</td>
                    <td style={{ padding: "10px 12px 10px 0", color: T.accent }}>{t.analyst_score ?? "—"}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      {t.outcome
                        ? <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px", background: t.outcome === "win" ? T.greenBg : T.redBg, color: t.outcome === "win" ? T.green : T.red }}>{t.outcome}</span>
                        : <span style={{ color: T.amber, fontSize: "11px" }}>open</span>}
                    </td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(t.executed_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
