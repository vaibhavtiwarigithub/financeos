"use client";
import { useState, useEffect, lazy, Suspense } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
const BenchmarkChart = lazy(() => import("@/components/charts/BenchmarkChart"));
const AllocationDonut = lazy(() => import("@/components/charts/AllocationDonut"));
const PnlBarChart = lazy(() => import("@/components/charts/PnlBarChart"));
const StockModal = lazy(() => import("@/components/charts/StockModal"));

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

// Currency symbol per market — US pool is USD, India pool is INR. Never blend the two.
const CURRENCY: Record<string, string> = { us: "$", india: "₹" };
const MARKET_LABEL: Record<string, string> = { us: "🇺🇸 US", india: "🇮🇳 India" };

function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }
function fmt(n: number, cur = "$") { return (n >= 0 ? "+" : "") + cur + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

// ── Gauge helpers ─────────────────────────────────────────────────────────────
const SEMI_R = 56;
const SEMI_CX = 72;
const SEMI_CY = 72;
const SEMI_CIRC = Math.PI * SEMI_R; // ≈ 175.9

function semiArcPath(cx: number, cy: number, r: number) {
  return `M ${cx - r},${cy} A ${r},${r} 0 0,1 ${cx + r},${cy}`;
}

/** Semicircle gauge — 0-100% */
function SemiGauge({
  value, label, sublabel, color,
}: { value: number | null; label: string; sublabel?: string; color: string }) {
  const clamp = Math.max(0, Math.min(100, value ?? 0));
  const filled = (clamp / 100) * SEMI_CIRC;
  const track = semiArcPath(SEMI_CX, SEMI_CY, SEMI_R);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <svg viewBox="0 0 144 84" style={{ width: "144px", height: "84px", overflow: "visible" }}>
        {/* Track */}
        <path d={track} fill="none" stroke={T.border} strokeWidth="10" strokeLinecap="round" />
        {/* Fill */}
        {value !== null && (
          <path
            d={track} fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
            strokeDasharray={`${filled} ${SEMI_CIRC}`}
          />
        )}
        {/* Value text */}
        <text x={SEMI_CX} y={SEMI_CY - 6} textAnchor="middle" fill={value !== null ? color : T.muted}
          fontSize="22" fontWeight="700" fontFamily="Inter, sans-serif">
          {value !== null ? Math.round(value) + "%" : "—"}
        </text>
      </svg>
      <div style={{ fontSize: "10px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.09em" }}>{label}</div>
      {sublabel && <div style={{ fontSize: "10px", color: T.muted }}>{sublabel}</div>}
    </div>
  );
}

/** Needle gauge — alpha centred at 0, range ±maxVal */
function NeedleGauge({
  value, maxVal, label, sublabel, loading,
}: { value: number; maxVal: number; label: string; sublabel?: string; loading?: boolean }) {
  const cx = SEMI_CX, cy = SEMI_CY;
  const r = SEMI_R;
  const needleR = r - 10;
  const track = semiArcPath(cx, cy, r);
  // angle: 0=up(270°svg), +max=right(0°svg), -max=left(180°svg)
  const clamped = Math.max(-maxVal, Math.min(maxVal, value));
  const angleDeg = (clamped / maxVal) * 90; // -90..+90
  const svgAngleRad = ((270 - angleDeg) * Math.PI) / 180;
  const nx = cx + needleR * Math.cos(svgAngleRad);
  const ny = cy + needleR * Math.sin(svgAngleRad);
  const color = value >= 0 ? T.green : T.red;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <svg viewBox="0 0 144 84" style={{ width: "144px", height: "84px", overflow: "visible" }}>
        {/* Track base */}
        <path d={track} fill="none" stroke={T.border} strokeWidth="10" strokeLinecap="round" />
        {/* Left half negative zone */}
        <path d={track} fill="none" stroke="#3B0000" strokeWidth="10"
          strokeDasharray={`${SEMI_CIRC / 2} ${SEMI_CIRC}`} strokeLinecap="butt" />
        {/* Right half positive zone */}
        <path d={track} fill="none" stroke="#052E16" strokeWidth="10"
          strokeDasharray={`0 ${SEMI_CIRC / 2} ${SEMI_CIRC / 2} 0`} strokeLinecap="butt" />
        {/* Centre tick */}
        <line x1={cx} y1={cy - r + 12} x2={cx} y2={cy - r + 4} stroke={T.muted} strokeWidth="2" />
        {/* Needle */}
        {!loading && (
          <>
            <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
            <circle cx={cx} cy={cy} r="4" fill={color} />
          </>
        )}
        {/* Value */}
        <text x={cx} y={cy - 8} textAnchor="middle" fill={loading ? T.muted : color}
          fontSize="17" fontWeight="700" fontFamily="Inter, sans-serif">
          {loading ? "…" : (value >= 0 ? "+" : "") + value.toFixed(1) + "%"}
        </text>
      </svg>
      <div style={{ fontSize: "10px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.09em" }}>{label}</div>
      {sublabel && <div style={{ fontSize: "10px", color: T.muted }}>{sublabel}</div>}
    </div>
  );
}

/** Cash vs deployed donut */
function CashDonut({ cashPct }: { cashPct: number }) {
  const deployedPct = 100 - cashPct;
  const r = 40, cx = 52, cy = 52;
  const circ = 2 * Math.PI * r;
  const deployedArc = (deployedPct / 100) * circ;
  const cashArc = (cashPct / 100) * circ;
  // start at top (offset = circ*0.25 rotates start to 12 o'clock)
  const offset = circ * 0.25;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px" }}>
      <svg viewBox="0 0 104 72" style={{ width: "104px", height: "72px" }}>
        {/* Cash (muted) */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.border} strokeWidth="11"
          strokeDasharray={`${cashArc} ${circ}`}
          strokeDashoffset={offset}
          strokeLinecap="butt" />
        {/* Deployed (accent) */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={T.accent} strokeWidth="11"
          strokeDasharray={`${deployedArc} ${circ}`}
          strokeDashoffset={offset - cashArc}
          strokeLinecap="butt" />
        {/* Centre */}
        <text x={cx} y={cy - 4} textAnchor="middle" fill={T.accent}
          fontSize="16" fontWeight="700" fontFamily="Inter, sans-serif">
          {deployedPct.toFixed(0)}%
        </text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill={T.muted}
          fontSize="8" fontFamily="Inter, sans-serif">
          deployed
        </text>
      </svg>
      <div style={{ fontSize: "10px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.09em" }}>Cash Allocation</div>
      <div style={{ fontSize: "10px", color: T.muted }}>{cashPct.toFixed(0)}% cash · {deployedPct.toFixed(0)}% invested</div>
    </div>
  );
}

/** Thin full-width NAV sparkline with gradient fill */
function NavSparkline({ perf, cur = "$" }: { perf: any[]; cur?: string }) {
  if (perf.length < 2) return null;
  const navs = perf.map(p => p.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const range = max - min || 1;
  const W = 800, H = 52;
  const PAD = 6;
  const pts = navs.map((v, i) =>
    `${(i / (navs.length - 1)) * W},${H - PAD - ((v - min) / range) * (H - PAD * 2)}`
  ).join(" ");
  const isUp = navs[navs.length - 1] >= navs[0];
  const color = isUp ? T.green : T.red;
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "14px 20px 10px", marginBottom: "20px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "8px" }}>
        NAV History · {perf.length} days
        <span style={{ marginLeft: "12px", color, fontWeight: 600 }}>
          {cur}{navs[navs.length - 1].toFixed(0)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: `${H}px` }} preserveAspectRatio="none">
        <defs>
          <linearGradient id="navGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.22" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#navGrad)" />
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Rich gauge+stats header row */
function PortfolioHeader({
  nav, cash, totalPnl, totalPnlPct, posValue, positions, winRate, wins, closedTrades, vooReturn, perf, cur = "$", startingNAV = 10000,
}: {
  nav: number; cash: number; totalPnl: number; totalPnlPct: number; posValue: number;
  positions: any[]; winRate: number | null; wins: number; closedTrades: any[];
  vooReturn: { pct: number | null; loading: boolean }; perf: any[]; cur?: string; startingNAV?: number;
}) {
  const cashPct = (cash / nav) * 100;
  const wr = winRate ?? 0;
  const wrColor = winRate !== null ? (wr >= 60 ? T.green : wr >= 40 ? T.amber : T.red) : T.muted;
  const alpha = vooReturn.pct !== null ? totalPnlPct - vooReturn.pct : 0;

  return (
    <>
      {/* Gauge + stats panel */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr auto", gap: "0",
        background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px",
        overflow: "hidden", marginBottom: "16px",
      }}>
        {/* Left — gauge cluster */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-around",
          padding: "24px 28px", borderRight: `1px solid ${T.border}`,
          gap: "8px",
        }}>
          <SemiGauge
            value={winRate}
            label="Win Rate"
            sublabel={winRate !== null ? `${wins}W / ${closedTrades.length - wins}L` : "no closed trades"}
            color={wrColor}
          />
          <div style={{ width: "1px", height: "80px", background: T.border }} />
          <NeedleGauge
            value={vooReturn.pct !== null ? alpha : 0}
            maxVal={20}
            label="Alpha vs VOO"
            sublabel={vooReturn.pct !== null ? `VOO ${vooReturn.pct >= 0 ? "+" : ""}${vooReturn.pct.toFixed(1)}%` : "loading…"}
            loading={vooReturn.loading}
          />
          <div style={{ width: "1px", height: "80px", background: T.border }} />
          <CashDonut cashPct={Math.max(0, Math.min(100, cashPct))} />
        </div>

        {/* Right — key numbers strip */}
        <div style={{
          display: "flex", flexDirection: "column", justifyContent: "center",
          gap: "20px", padding: "24px 32px", minWidth: "260px",
        }}>
          {/* Paper NAV */}
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Paper NAV</div>
            <div style={{ fontSize: "32px", fontWeight: 800, letterSpacing: "-0.02em", color: T.text, lineHeight: 1 }}>
              {cur}{nav.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
            </div>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "3px" }}>started {cur}{startingNAV.toLocaleString("en-US")}</div>
          </div>

          {/* Total P&L */}
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Total P&L</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "8px" }}>
              <span style={{ fontSize: "22px", fontWeight: 700, color: pnlColor(totalPnl), letterSpacing: "-0.01em" }}>
                {fmt(totalPnl, cur)}
              </span>
              <span style={{
                fontSize: "12px", fontWeight: 600,
                color: pnlColor(totalPnl),
                background: totalPnl >= 0 ? T.greenBg : T.redBg,
                padding: "2px 7px", borderRadius: "5px",
              }}>
                {fmtPct(totalPnlPct)}
              </span>
            </div>
          </div>

          {/* Positions summary */}
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.09em", marginBottom: "4px" }}>Positions</div>
            <div style={{ fontSize: "14px", fontWeight: 600, color: T.text }}>
              {positions.length} open
              <span style={{ color: T.muted, fontWeight: 400, marginLeft: "6px" }}>·</span>
              <span style={{ color: T.textSub, fontWeight: 500, marginLeft: "6px" }}>
                {cur}{posValue.toLocaleString("en-US", { maximumFractionDigits: 0 })} deployed
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* NAV sparkline */}
      <NavSparkline perf={perf} cur={cur} />
    </>
  );
}

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

function TradeQueueTab({ pendingSignals, strategy, tradeQueue }: {
  pendingSignals: any[]; strategy: any; tradeQueue: any[];
}) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<string[]>([]);
  const [innerTab, setInnerTab] = useState<"queue" | "signals">("queue");
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<any[]>(tradeQueue);
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

  async function runPaperTrade() {
    setRunning(true);
    setRunLog(["Running PaperTrader..."]);
    try {
      const res = await fetch("/api/agents/paper-trade", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
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
    <div>
      {/* Strategy config card */}
      {strategy && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "16px", display: "flex", gap: "32px", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Trading</div>
            <span style={{ fontSize: "13px", fontWeight: 700, color: strategy.trading_enabled ? T.green : T.red }}>
              {strategy.trading_enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Max Daily Trades</div>
            <span style={{ fontSize: "13px", fontWeight: 700 }}>{strategy.max_daily_trades ?? "—"}</span>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Min Analyst Score</div>
            <span style={{ fontSize: "13px", fontWeight: 700 }}>{strategy.min_analyst_score ?? "—"}</span>
          </div>
          <div>
            <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Mode</div>
            <span style={{ fontSize: "13px", fontWeight: 700 }}>{strategy.mode ?? "paper"}</span>
          </div>
          <div style={{ marginLeft: "auto" }}>
            <button
              onClick={runPaperTrade}
              disabled={running}
              style={{ padding: "9px 20px", borderRadius: "9px", fontWeight: 700, fontSize: "12px", cursor: running ? "default" : "pointer", border: "none", background: running ? T.border : T.accent, color: "#fff", opacity: running ? 0.7 : 1 }}
            >
              {running ? "Running..." : "Run PaperTrader"}
            </button>
          </div>
        </div>
      )}

      {/* Run log */}
      {runLog.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 16px", marginBottom: "16px", fontFamily: "monospace", fontSize: "12px" }}>
          {runLog.map((l, i) => <div key={i} style={{ color: l.startsWith("Error") ? T.red : l.startsWith("Skipped") ? T.amber : T.green }}>{l}</div>)}
        </div>
      )}

      {/* Inner tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px" }}>
        {(["queue", "signals"] as const).map(t => (
          <button key={t} onClick={() => setInnerTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: innerTab === t ? T.accent : T.card, color: innerTab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t === "queue" ? `Trade Queue (${queueItems.length})` : `Pending Signals (${pendingSignals.length})`}
          </button>
        ))}
      </div>

      {/* Trade queue */}
      {innerTab === "queue" && (
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
                <div style={{ fontWeight: 800, fontSize: "16px", color: T.accent, cursor: "pointer" }} onClick={() => router.push(`/dashboard/symbol/${q.symbol}`)}>
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

      {/* Pending signals */}
      {innerTab === "signals" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {pendingSignals.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted, fontSize: "13px" }}>
              No pending signals. Run ResearchAgent from the Agents page to generate signals.
            </div>
          ) : pendingSignals.map((s: any) => (
            <div key={s.id} style={{ background: T.card, border: `1px solid ${s.analyst_score >= 60 && s.direction === "long" ? T.accent + "44" : T.border}`, borderRadius: "12px", padding: "16px 20px", display: "grid", gridTemplateColumns: "80px 1fr 1fr 1fr 1fr", gap: "12px", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <div style={{ fontWeight: 800, fontSize: "16px", cursor: "pointer", color: T.accent }} onClick={() => router.push(`/dashboard/symbol/${s.symbol}`)}>{s.symbol} ↗</div>
                <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: "#2D1B00", color: "#FBBF24", letterSpacing: "0.04em" }}>PAPER</span>
              </div>
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
    </div>
  );
}

function LiveHoldingsTab() {
  const [data, setData] = useState<{ positions: any[]; cached?: boolean; stale?: boolean } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/portfolio/live-holdings")
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const positions = data?.positions ?? [];
  const totalValue = positions.reduce((sum, p) => sum + (p.qty * (p.current_price || p.avg_cost)), 0);
  const totalPnl = positions.reduce((sum, p) => {
    if (!p.current_price || !p.avg_cost) return sum;
    return sum + (p.current_price - p.avg_cost) * p.qty;
  }, 0);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, color: T.text }}>Robinhood Live Positions</div>
        {data?.stale && (
          <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "4px", background: T.amberBg, color: T.amber, fontWeight: 600 }}>STALE CACHE</span>
        )}
        {data?.cached && !data?.stale && (
          <span style={{ fontSize: "11px", color: T.muted }}>cached</span>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ color: T.muted, fontSize: "13px", marginBottom: "8px" }}>Fetching positions…</div>
          <div style={{ color: T.muted, fontSize: "11px" }}>Fetching from Robinhood via AI subprocess — may take ~90s on first load</div>
        </div>
      ) : positions.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>
          No live positions found. Make sure the Robinhood MCP is connected.
        </div>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ color: T.muted }}>
                {["Symbol", "Shares", "Avg Cost", "Current Price", "Market Value", "P&L", "P&L %"].map(h => (
                  <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.map((p: any, i: number) => {
                const cur = p.current_price || 0;
                const pnl = cur && p.avg_cost ? (cur - p.avg_cost) * p.qty : 0;
                const pnlPct = cur && p.avg_cost ? ((cur - p.avg_cost) / p.avg_cost) * 100 : 0;
                const value = (cur || p.avg_cost) * p.qty;
                return (
                  <tr key={p.symbol + i} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700, color: T.accent }}>
                      {p.symbol}
                      {p.name && p.name !== p.symbol && (
                        <div style={{ fontSize: "11px", fontWeight: 400, color: T.muted, marginTop: "2px" }}>{p.name}</div>
                      )}
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{p.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{p.avg_cost ? "$" + Number(p.avg_cost).toFixed(2) : <span style={{ color: T.muted }}>—</span>}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{cur ? "$" + Number(cur).toFixed(2) : <span style={{ color: T.muted }}>—</span>}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>${value.toFixed(0)}</td>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: pnl >= 0 ? T.green : T.red }}>
                      {cur && p.avg_cost ? (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2) : <span style={{ color: T.muted }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 0", color: pnlPct >= 0 ? T.green : T.red }}>
                      {cur && p.avg_cost ? (pnlPct >= 0 ? "+" : "") + pnlPct.toFixed(2) + "%" : <span style={{ color: T.muted }}>—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: "12px", paddingTop: "12px", display: "flex", gap: "32px" }}>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total Value</div>
              <div style={{ fontSize: "18px", fontWeight: 700, color: T.text }}>${totalValue.toFixed(0)}</div>
            </div>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Total P&L</div>
              <div style={{ fontSize: "18px", fontWeight: 700, color: totalPnl >= 0 ? T.green : T.red }}>
                {(totalPnl >= 0 ? "+" : "") + "$" + Math.abs(totalPnl).toFixed(2)}
              </div>
            </div>
          </div>
        </>
      )}
      <div style={{ marginTop: "16px", fontSize: "11px", color: T.muted }}>
        Robinhood Trading account ••••8641 • non-agentic • read-only
      </div>
    </div>
  );
}

/** Rich position card — replaces plain table row */
function PositionCard({ p, onChart, cur = "$" }: { p: any; onChart: (sym: string) => void; cur?: string }) {
  const px = p.current_price ?? p.avg_cost;
  const pnl = (px - p.avg_cost) * p.qty;
  const pnlPct = ((px - p.avg_cost) / p.avg_cost) * 100;
  const posValue = px * p.qty;
  const hasLive = !!p.current_price;
  const pColor = pnlColor(pnl);
  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderRadius: "12px", padding: "16px 20px",
      display: "grid", gridTemplateColumns: "1fr auto",
      gap: "12px", alignItems: "center",
    }}>
      {/* Left: symbol + price flow */}
      <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            style={{ fontWeight: 800, fontSize: "18px", color: T.accent, cursor: "pointer", letterSpacing: "-0.01em" }}
            onClick={() => onChart(p.symbol)}
          >
            {p.symbol} ↗
          </span>
          <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: T.amberBg, color: T.amber, letterSpacing: "0.05em" }}>
            PAPER
          </span>
          <span style={{ fontSize: "12px", color: T.muted }}>{p.qty} shares</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: T.textSub }}>
          <span>{cur}{p.avg_cost.toFixed(2)}</span>
          <span style={{ color: T.muted }}>→</span>
          <span style={{ color: hasLive ? T.text : T.muted, fontWeight: hasLive ? 600 : 400 }}>
            {hasLive ? cur + p.current_price.toFixed(2) : "—"}
          </span>
        </div>
      </div>

      {/* Right: P&L + value */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "7px" }}>
          <span style={{ fontSize: "17px", fontWeight: 700, color: pColor }}>
            {fmt(pnl, cur)}
          </span>
          <span style={{
            fontSize: "11px", fontWeight: 600, color: pColor,
            background: pnl >= 0 ? T.greenBg : T.redBg,
            padding: "2px 6px", borderRadius: "4px",
          }}>
            {fmtPct(pnlPct)}
          </span>
        </div>
        <div style={{ fontSize: "12px", color: T.muted }}>{cur}{posValue.toFixed(0)} value</div>
      </div>
    </div>
  );
}

export default function PortfolioPage({ pools, positions: allPositions, trades: allTrades, perf: allPerf, signals, pendingSignals, strategy, tradeQueue }: {
  pools: any[]; positions: any[]; trades: any[]; perf: any[]; signals: any[];
  pendingSignals: any[]; strategy: any; tradeQueue: any[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<"positions" | "trades" | "signals" | "live" | "opportunity" | "tradequeue">("positions");
  const [chartSymbol, setChartSymbol] = useState<string | null>(null);
  const [vooReturn, setVooReturn] = useState<{ pct: number | null; loading: boolean }>({ pct: null, loading: true });

  // Phase 4: market-scoped pools. Each pool holds funds in its own currency
  // (US=USD, India=INR) — NEVER blend a $ value with a ₹ value. Pre-057 there's
  // one row with no market column: treat it as US (market ?? "us").
  const poolList = pools ?? [];
  const hasIndia = poolList.some((p: any) => p.market === "india");
  const [market, setMarket] = useState<"us" | "india">("us");
  const activeMarket = market === "india" && hasIndia ? "india" : "us";
  const cur = CURRENCY[activeMarket] ?? "$";
  // Pick this market's pool; pre-057 (no market col) fall back to the sole row.
  const portfolio =
    poolList.find((p: any) => (p.market ?? "us") === activeMarket) ??
    (poolList.length === 1 && !poolList[0]?.market ? poolList[0] : null);
  // Scope positions/trades/perf to the selected market (un-tagged rows = US).
  const positions = (allPositions ?? []).filter((p: any) => (p.market ?? "us") === activeMarket);
  const trades = (allTrades ?? []).filter((t: any) => (t.market ?? "us") === activeMarket);
  const perf = (allPerf ?? []).filter((p: any) => (p.market ?? "us") === activeMarket);

  useEffect(() => {
    fetch("/api/charts/price-history?symbol=VOO&days=90")
      .then(r => r.json())
      .then(d => {
        const candles = d.candles ?? [];
        if (candles.length >= 2) {
          const start = candles[0].close;
          const end = candles[candles.length - 1].close;
          setVooReturn({ pct: ((end - start) / start) * 100, loading: false });
        } else {
          setVooReturn({ pct: null, loading: false });
        }
      })
      .catch(() => setVooReturn({ pct: null, loading: false }));
  }, []);

  // Starting NAV differs per market: US pool = $10k, India ₹ pool = ₹1,000,000.
  const startingNAV = activeMarket === "india" ? 1000000 : 10000;
  const nav = portfolio?.nav ?? startingNAV;
  const cash = portfolio?.cash_balance ?? startingNAV;
  const totalPnl = nav - startingNAV;
  const totalPnlPct = (totalPnl / startingNAV) * 100;
  const posValue = nav - cash;
  const closedTrades = trades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.outcome === "win").length;
  const winRate = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : null;

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Paper Portfolio"
        subtitle={`NAV ${cur}${nav.toFixed(0)} · ${positions.length} open position${positions.length !== 1 ? "s" : ""}`}
        cadence="weekly"
        whatItDoes="Your paper trading portfolio — all open positions, closed trades, P&L history, and pending signals queue. Agent executes paper trades automatically each morning."
        whatToLookFor={[
          "Positions tab: check unrealized P&L on open trades. Exit if signal flips to 'short'.",
          "Trade Queue tab: signals the agent wants to act on — approve or reject before next cron run.",
          "Win rate should trend above 50% after 20+ trades. Below = prompt/screener adjustment needed.",
          "Compare NAV vs VOO benchmark — are you beating the index?",
        ]}
      />
      <div style={{ padding: "4px 28px 28px" }}>

      <div style={{ marginBottom: "20px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "16px" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Paper Trading Portfolio</div>
          <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>Paper Portfolio</h1>
        </div>

        {/* Market selector — only shows India when that ₹ pool exists (post-057).
            US and India NAV are NEVER blended: each renders in its own currency. */}
        {hasIndia && (
          <div style={{ display: "flex", gap: "4px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "3px" }}>
            {(["us", "india"] as const).map(m => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                style={{
                  padding: "7px 16px", borderRadius: "7px", fontSize: "12px", fontWeight: 700,
                  cursor: "pointer", border: "none",
                  background: activeMarket === m ? T.accent : "transparent",
                  color: activeMarket === m ? "#fff" : T.muted,
                }}
              >
                {MARKET_LABEL[m]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Rich header: gauge cluster + key numbers + sparkline */}
      <PortfolioHeader
        nav={nav}
        cash={cash}
        totalPnl={totalPnl}
        totalPnlPct={totalPnlPct}
        posValue={posValue}
        positions={positions}
        winRate={winRate}
        wins={wins}
        closedTrades={closedTrades}
        vooReturn={vooReturn}
        perf={perf}
        cur={cur}
        startingNAV={startingNAV}
      />

      {/* Charts row */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "16px", marginBottom: "20px" }}>
        <Suspense fallback={<div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", height: "280px", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontSize: "13px" }}>Loading chart…</div>}>
          <BenchmarkChart perfRows={perf} />
        </Suspense>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <Suspense fallback={null}>
            <AllocationDonut positions={positions} cash={portfolio?.cash_balance ?? startingNAV} />
          </Suspense>
        </div>
      </div>

      {/* P&L bar */}
      <div style={{ marginBottom: "20px" }}>
        <Suspense fallback={null}>
          <PnlBarChart trades={trades} />
        </Suspense>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px" }}>
        {(["positions", "trades", "signals"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t}{t === "positions" ? ` (${positions.length})` : t === "trades" ? ` (${trades.length})` : ` (${signals.length})`}
          </button>
        ))}
        <button onClick={() => setTab("live")} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === "live" ? T.accent : T.card, color: tab === "live" ? "#fff" : T.muted }}>
          Live Holdings
        </button>
        <button onClick={() => setTab("opportunity" as any)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === ("opportunity" as any) ? T.accent : T.card, color: tab === ("opportunity" as any) ? "#fff" : T.muted }}>
          Opportunity Cost
        </button>
        <button onClick={() => setTab("tradequeue")} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === "tradequeue" ? T.accent : T.card, color: tab === "tradequeue" ? "#fff" : T.muted }}>
          Trade Queue {tradeQueue.length > 0 ? `(${tradeQueue.length})` : ""}
        </button>
      </div>

      {/* Positions tab — rich cards */}
      {tab === "positions" && (
        <div>
          {positions.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", color: T.muted, fontSize: "13px", textAlign: "center" }}>
              No open positions. Run ResearchAgent then PaperTrader to open positions.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {positions.map((p: any) => (
                <PositionCard key={p.id} p={p} cur={cur} onChart={sym => router.push(`/dashboard/symbol/${sym}`)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Trades tab */}
      {tab === "trades" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {trades.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No paper trades yet.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Side", "Qty", "Fill Price", "Total", "Score", "P&L", "Outcome", "Date"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.map((t: any) => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        {t.symbol}
                        <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: "#2D1B00", color: "#FBBF24", letterSpacing: "0.04em" }}>PAPER</span>
                      </div>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: t.order_side === "buy" ? T.greenBg : T.redBg, color: t.order_side === "buy" ? T.green : T.red }}>
                        {t.order_side.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{cur}{t.fill_price?.toFixed(2)}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{cur}{(t.qty * t.fill_price)?.toFixed(0)}</td>
                    <td style={{ padding: "10px 12px 10px 0", color: T.accent }}>{t.analyst_score ?? "—"}</td>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: t.realized_pnl != null ? pnlColor(t.realized_pnl) : T.muted }}>
                      {t.realized_pnl != null ? fmt(t.realized_pnl, cur) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      {t.outcome ? (
                        <span style={{ fontSize: "11px", fontWeight: 600, padding: "2px 7px", borderRadius: "4px", background: t.outcome === "win" ? T.greenBg : t.outcome === "loss" ? T.redBg : T.amberBg, color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.amber }}>
                          {t.outcome}
                        </span>
                      ) : <span style={{ color: T.amber, fontSize: "11px" }}>open</span>}
                    </td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(t.executed_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Stock chart modal */}
      {chartSymbol && (
        <Suspense fallback={null}>
          <StockModal symbol={chartSymbol} onClose={() => setChartSymbol(null)} />
        </Suspense>
      )}

      {/* Live Holdings tab */}
      {tab === "live" && <LiveHoldingsTab />}

      {/* Signals tab */}
      {tab === "signals" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {signals.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>No signals yet. Run ResearchAgent to generate signals.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Direction", "Score", "Conviction", "Status", "Created"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {signals.map((s: any) => (
                  <tr key={s.id} style={{ borderTop: `1px solid ${T.border}` }}>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{s.symbol}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: s.direction === "long" ? T.greenBg : T.amberBg, color: s.direction === "long" ? T.green : T.amber }}>
                        {s.direction?.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0", color: s.analyst_score >= 70 ? T.green : s.analyst_score >= 50 ? T.amber : T.red, fontWeight: 600 }}>{s.analyst_score}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{s.conviction}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", padding: "2px 7px", borderRadius: "4px", background: s.status === "pending" ? T.amberBg : s.status === "paper_traded" ? T.greenBg : T.card, color: s.status === "pending" ? T.amber : s.status === "paper_traded" ? T.green : T.muted }}>
                        {s.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(s.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Trade Queue tab */}
      {tab === "tradequeue" && (
        <TradeQueueTab
          pendingSignals={pendingSignals}
          strategy={strategy}
          tradeQueue={tradeQueue}
        />
      )}

      {/* Opportunity Cost tab */}
      {tab === ("opportunity" as any) && (() => {
        const taken = signals.filter(s => s.status === "paper_traded");
        const skipped = signals.filter(s => s.status === "pending" || s.status === "neutral");
        const takenPnl = trades.filter(t => t.closed_at && t.realized_pnl != null).reduce((s: number, t: any) => s + t.realized_pnl, 0);
        const openTrades = trades.filter(t => !t.closed_at);
        const rows = [
          ...taken.map((s: any) => {
            const trade = trades.find((t: any) => t.signal_id === s.id);
            return { ...s, _type: "taken", trade };
          }),
          ...skipped.map((s: any) => ({ ...s, _type: "skipped", trade: null })),
        ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

        return (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ display: "flex", gap: "24px", marginBottom: "20px", paddingBottom: "16px", borderBottom: `1px solid ${T.border}` }}>
              <div>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Signals Taken</div>
                <div style={{ fontSize: "22px", fontWeight: 700, color: T.green }}>{taken.length}</div>
              </div>
              <div>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Signals Skipped</div>
                <div style={{ fontSize: "22px", fontWeight: 700, color: T.amber }}>{skipped.length}</div>
              </div>
              <div>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Realized P&L (taken)</div>
                <div style={{ fontSize: "22px", fontWeight: 700, color: takenPnl >= 0 ? T.green : T.red }}>{takenPnl >= 0 ? "+" : ""}{cur}{takenPnl.toFixed(2)}</div>
              </div>
              <div>
                <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>Open Positions</div>
                <div style={{ fontSize: "22px", fontWeight: 700 }}>{openTrades.length}</div>
              </div>
            </div>
            {rows.length === 0 ? (
              <div style={{ color: T.muted, textAlign: "center", padding: "24px 0", fontSize: "13px" }}>No signals yet. Run ResearchAgent to generate signals.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                <thead>
                  <tr style={{ color: T.muted }}>
                    {["Symbol", "Direction", "Score", "Status", "Result", "P&L", "Date"].map(h => (
                      <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: any, i: number) => (
                    <tr key={r.id + i} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{r.symbol}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>
                        <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: r.direction === "long" ? T.greenBg : r.direction === "short" ? T.redBg : T.amberBg, color: r.direction === "long" ? T.green : r.direction === "short" ? T.red : T.amber }}>
                          {r.direction?.toUpperCase()}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px 10px 0", color: r.analyst_score >= 70 ? T.green : r.analyst_score >= 50 ? T.amber : T.red, fontWeight: 600 }}>{r.analyst_score}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>
                        <span style={{ fontSize: "11px", padding: "2px 7px", borderRadius: "4px", background: r._type === "taken" ? T.greenBg : T.amberBg, color: r._type === "taken" ? T.green : T.amber }}>
                          {r._type === "taken" ? "TAKEN" : "SKIPPED"}
                        </span>
                      </td>
                      <td style={{ padding: "10px 12px 10px 0", fontSize: "11px", color: T.muted }}>
                        {r.trade ? (r.trade.closed_at ? r.trade.outcome?.toUpperCase() : "open") : "—"}
                      </td>
                      <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: r.trade?.realized_pnl != null ? (r.trade.realized_pnl >= 0 ? T.green : T.red) : T.muted }}>
                        {r.trade?.realized_pnl != null ? (r.trade.realized_pnl >= 0 ? "+" : "") + cur + Math.abs(r.trade.realized_pnl).toFixed(2) : "—"}
                      </td>
                      <td style={{ padding: "10px 0", color: T.muted, fontSize: "11px" }}>{new Date(r.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })()}
      </div>
    </div>
  );
}
