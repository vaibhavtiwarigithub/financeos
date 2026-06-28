"use client";
import { useState } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

function pnlColor(n: number) { return n >= 0 ? T.green : T.red; }
function fmt(n: number) { return (n >= 0 ? "+" : "") + "$" + Math.abs(n).toFixed(2); }
function fmtPct(n: number) { return (n >= 0 ? "+" : "") + n.toFixed(2) + "%"; }

function MiniChart({ perf }: { perf: any[] }) {
  if (perf.length < 2) return <div style={{ color: T.muted, fontSize: "12px" }}>No chart data yet</div>;
  const navs = perf.map(p => p.nav);
  const min = Math.min(...navs);
  const max = Math.max(...navs);
  const range = max - min || 1;
  const w = 320, h = 80;
  const pts = navs.map((v, i) => `${(i / (navs.length - 1)) * w},${h - ((v - min) / range) * (h - 8)}`).join(" ");
  const isUp = navs[navs.length - 1] >= navs[0];
  const color = isUp ? T.green : T.red;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: "80px" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  );
}

export default function PortfolioPage({ portfolio, positions, trades, perf, signals }: {
  portfolio: any; positions: any[]; trades: any[]; perf: any[]; signals: any[];
}) {
  const [tab, setTab] = useState<"positions" | "trades" | "signals">("positions");

  const startingNAV = 10000;
  const nav = portfolio?.nav ?? startingNAV;
  const cash = portfolio?.cash_balance ?? startingNAV;
  const totalPnl = nav - startingNAV;
  const totalPnlPct = (totalPnl / startingNAV) * 100;
  const posValue = nav - cash;
  const closedTrades = trades.filter(t => t.closed_at);
  const wins = closedTrades.filter(t => t.outcome === "win").length;
  const winRate = closedTrades.length ? Math.round((wins / closedTrades.length) * 100) : null;

  const statCard = (label: string, value: string, sub?: string, color?: string) => (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>{label}</div>
      <div style={{ fontSize: "24px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
      {sub && <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Paper Trading Portfolio</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>Portfolio</h1>
      </div>

      {/* Stats row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: "16px", marginBottom: "24px" }}>
        {statCard("Paper NAV", "$" + nav.toFixed(0), "started $10,000")}
        {statCard("Total P&L", fmt(totalPnl), fmtPct(totalPnlPct), pnlColor(totalPnl))}
        {statCard("Cash", "$" + cash.toFixed(0), `${positions.length} position${positions.length !== 1 ? "s" : ""}`)}
        {statCard("Invested", "$" + posValue.toFixed(0), `${((posValue / nav) * 100).toFixed(1)}% deployed`)}
        {statCard("Win Rate", winRate !== null ? winRate + "%" : "—", `${wins}W/${closedTrades.length - wins}L of ${closedTrades.length}`, winRate !== null ? (winRate >= 60 ? T.green : winRate >= 40 ? T.amber : T.red) : T.muted)}
      </div>

      {/* NAV chart */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "20px" }}>
        <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px" }}>NAV History</div>
        <MiniChart perf={perf} />
        {perf.length === 0 && (
          <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "12px 0" }}>
            NAV chart builds as paper trades close. Run ResearchAgent + PaperTrader to start.
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "16px" }}>
        {(["positions", "trades", "signals"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t}{t === "positions" ? ` (${positions.length})` : t === "trades" ? ` (${trades.length})` : ` (${signals.length})`}
          </button>
        ))}
      </div>

      {/* Positions tab */}
      {tab === "positions" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
          {positions.length === 0 ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "24px 0" }}>
              No open positions. Run ResearchAgent then PaperTrader to open positions.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ color: T.muted }}>
                  {["Symbol", "Qty", "Avg Cost", "Current", "Value", "P&L", "P&L %"].map(h => (
                    <th key={h} style={{ padding: "5px 12px 10px 0", fontWeight: 500, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.05em", textAlign: "left" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map((p: any) => {
                  const cur = p.current_price ?? p.avg_cost;
                  const pnl = (cur - p.avg_cost) * p.qty;
                  const pnlPct = ((cur - p.avg_cost) / p.avg_cost) * 100;
                  return (
                    <tr key={p.id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{p.symbol}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>{p.qty}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>${p.avg_cost.toFixed(2)}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>{p.current_price ? "$" + p.current_price.toFixed(2) : <span style={{ color: T.muted }}>—</span>}</td>
                      <td style={{ padding: "10px 12px 10px 0" }}>${(cur * p.qty).toFixed(0)}</td>
                      <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: pnlColor(pnl) }}>{fmt(pnl)}</td>
                      <td style={{ padding: "10px 0", color: pnlColor(pnlPct) }}>{fmtPct(pnlPct)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 700 }}>{t.symbol}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: t.order_side === "buy" ? T.greenBg : T.redBg, color: t.order_side === "buy" ? T.green : T.red }}>
                        {t.order_side.toUpperCase()}
                      </span>
                    </td>
                    <td style={{ padding: "10px 12px 10px 0" }}>{t.qty}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>${t.fill_price?.toFixed(2)}</td>
                    <td style={{ padding: "10px 12px 10px 0" }}>${(t.qty * t.fill_price)?.toFixed(0)}</td>
                    <td style={{ padding: "10px 12px 10px 0", color: T.accent }}>{t.analyst_score ?? "—"}</td>
                    <td style={{ padding: "10px 12px 10px 0", fontWeight: 600, color: t.realized_pnl != null ? pnlColor(t.realized_pnl) : T.muted }}>
                      {t.realized_pnl != null ? fmt(t.realized_pnl) : "—"}
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
    </div>
  );
}
