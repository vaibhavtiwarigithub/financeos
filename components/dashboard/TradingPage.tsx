"use client";
import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
const StockModal = lazy(() => import("@/components/charts/StockModal"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function fmt(n: number) { return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }
function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }

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
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Agent Trading</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>Trading</h1>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              onClick={runPaperTrade}
              disabled={running}
              style={{ padding: "10px 22px", borderRadius: "10px", fontWeight: 700, fontSize: "13px", cursor: running ? "default" : "pointer", border: "none", background: running ? T.border : T.accent, color: "#fff", opacity: running ? 0.7 : 1 }}
            >
              {running ? "Running..." : "Run PaperTrader"}
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "20px" }}>
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
                <div style={{ marginTop: "10px", fontSize: "11px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "10px" }}>
                  {q.rationale.slice(0, 200)}{q.rationale.length > 200 ? "…" : ""}
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
          )}
        </div>
      )}
    </div>
  );
}
