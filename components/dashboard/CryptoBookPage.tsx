"use client";
// Structured to match app/dashboard/portfolio's PortfolioPage: shared rich
// header (PaperBookHeader — win-rate gauge, cash donut, NAV, P&L, sparkline)
// + a tab bar instead of stacked sections, SymbolLink on every symbol. Only
// equities-specific tabs are dropped (Trade Queue, Live Holdings, Opportunity
// Cost — none apply to a keyless, broker-detached crypto paper book); the
// crypto-specific research/strategy panels the old flat layout already had
// become their own tabs instead of always-visible stacked sections.
import { useState } from "react";
import { SymbolLink } from "@/components/ui/SymbolLink";
import PageHeader from "@/components/dashboard/PageHeader";
import { fmtMoney } from "@/lib/format-money";
import { PAPER_BOOK_T as T, pnlColor, fmtSignedMoney, fmtSignedPct, PaperBookHeader, type PaperBookTradeRecord } from "@/components/dashboard/PaperBookHeader";

const CRYPTO_STARTING_NAV = 10000;

const usd = (value: unknown) => `$${Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString() : "—";
const pct = (value: unknown) => `${Number(value ?? 0).toFixed(2)}%`;

export default function CryptoBookPage({
  pool, positions, trades, perf, latestUniverse, shadows, strategies, members, viewerMode = false,
}: {
  pool: { nav: number; cash_balance: number; updated_at: string } | null;
  positions: any[]; trades: any[]; perf: any[];
  latestUniverse: any | null; shadows: any[]; strategies: any[]; members: any[];
  viewerMode?: boolean;
}) {
  const [tab, setTab] = useState<"positions" | "trades" | "research" | "strategy">("positions");

  const nav = pool?.nav ?? CRYPTO_STARTING_NAV;
  const cash = pool?.cash_balance ?? CRYPTO_STARTING_NAV;
  const totalPnl = nav - CRYPTO_STARTING_NAV;
  const totalPnlPct = (totalPnl / CRYPTO_STARTING_NAV) * 100;
  const posValue = nav - cash;

  const closed = trades.filter((t: any) => t.outcome != null);
  const wins = closed.filter((t: any) => t.outcome === "win").length;
  const losses = closed.filter((t: any) => t.outcome === "loss").length;
  const breakeven = closed.filter((t: any) => t.outcome === "breakeven").length;
  const realizedPnl = closed.reduce((sum: number, t: any) => sum + Number(t.realized_pnl ?? 0), 0);
  const tradeRecord: PaperBookTradeRecord = { wins, losses, breakeven, closed: closed.length };
  const winRate = closed.length ? Math.round((wins / closed.length) * 100) : null;

  const latestShadowBySymbol = new Map<string, any>();
  for (const shadow of shadows ?? []) if (!latestShadowBySymbol.has(shadow.symbol)) latestShadowBySymbol.set(shadow.symbol, shadow);
  const summary: any = latestUniverse?.summary ?? {};
  const readiness = latestUniverse ? `${summary.broker_pairs ?? 0} broker pairs · ${summary.research_targets ?? 0} researched · ${summary.admitted ?? 0} eligible` : "Capability discovery not connected";

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Crypto Markets"
        subtitle={`NAV ${usd(nav)} · ${positions.length} open position${positions.length !== 1 ? "s" : ""}`}
        cadence="daily"
        whatItDoes="Shows the crypto paper book, deterministic research evidence, strategy shadows, and the exact blockers before any crypto order could be submitted. Separate 24/7 research and paper-trading book — never blended with equities."
        whatToLookFor={[
          "A tradeable quote and broker eligibility are hard gates; a high score cannot override either.",
          "Stops, targets, and size shown here are shadow evidence until they have enough paper outcomes.",
          "Live crypto is disabled: no broker order path is activated from this page.",
        ]}
      />
      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px)" }}>

        {viewerMode && (
          <div style={{ background: "#1A1530", border: `1px solid ${T.accent}`, borderRadius: "10px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}>
            <strong style={{ color: T.accent }}>This is the owner&apos;s crypto paper book.</strong>{" "}
            A simulated book belonging to the account owner — not your account, not your returns, and
            not investment advice. Your access is read-only.
          </div>
        )}

        <div style={{ background: "#062B22", border: "1px solid #34D39944", color: T.green, borderRadius: 10, padding: "12px 14px", marginBottom: 16, fontSize: 13, lineHeight: 1.5 }}>
          <strong>Crypto paper trading is active.</strong> Kairos evaluates deterministic crypto research daily and records simulated entries, stops, targets and exits in this separate paper book. No live Robinhood crypto order is sent from this page.
        </div>

        <PaperBookHeader
          nav={nav} cash={cash} totalPnl={totalPnl} totalPnlPct={totalPnlPct} posValue={posValue}
          positionCount={positions.length} winRate={winRate} tradeRecord={tradeRecord} perf={perf}
          cur="$" startingNAV={CRYPTO_STARTING_NAV} gradientId="cryptoNavGrad"
        />

        <div style={{ display: "flex", gap: "4px", marginBottom: "16px", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          {([
            ["positions", `Positions (${positions.length})`],
            ["trades", `Trades (${trades.length})`],
            ["research", "Research"],
            ["strategy", "Strategy"],
          ] as const).map(([t, label]) => (
            <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted }}>
              {label}
            </button>
          ))}
        </div>

        {tab === "positions" && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
            {positions.length === 0 ? <p style={{ color: T.muted, fontSize: 13 }}>No open crypto paper positions.</p> : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ minWidth: 590, width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Symbol", "Entry", "Mark", "Stop", "Target", "Unrealized"].map(h => <th key={h} style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>{h}</th>)}</tr></thead>
                  <tbody>{positions.map((p: any) => {
                    const entry = Number(p.entry_price); const mark = Number(p.current_price);
                    const returnPct = entry > 0 ? ((mark - entry) / entry) * 100 : 0;
                    return (
                      <tr key={p.symbol} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "10px 8px 10px 0", fontWeight: 700 }}><SymbolLink symbol={p.symbol} style={{ color: T.text }} /></td>
                        <td>{usd(entry)}</td><td>{usd(mark)}</td>
                        <td>{p.stop_loss == null ? "—" : usd(p.stop_loss)}</td>
                        <td>{p.price_target == null ? "—" : usd(p.price_target)}</td>
                        <td style={{ color: returnPct >= 0 ? T.green : T.red }}>{pct(returnPct)}</td>
                      </tr>
                    );
                  })}</tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "trades" && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
            {trades.length === 0 ? <p style={{ color: T.muted, fontSize: 13 }}>No crypto paper trades yet.</p> : (
              <>
                <div style={{ color: T.muted, fontSize: 11, marginBottom: 10 }}>Closed: {closed.length} ({wins}W / {losses}L{breakeven > 0 ? ` / ${breakeven}BE` : ""}) · Realized P&amp;L {fmtSignedMoney(realizedPnl)}</div>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ minWidth: 480, width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Symbol", "Outcome", "Realized P&L", "Executed"].map(h => <th key={h} style={{ padding: "0 8px 8px 0", fontWeight: 600 }}>{h}</th>)}</tr></thead>
                    <tbody>{trades.map((t: any) => (
                      <tr key={t.id} style={{ borderTop: `1px solid ${T.border}` }}>
                        <td style={{ padding: "10px 8px 10px 0", fontWeight: 700 }}><SymbolLink symbol={t.symbol} style={{ color: T.text }} /></td>
                        <td style={{ color: t.outcome === "win" ? T.green : t.outcome === "loss" ? T.red : T.muted }}>{t.outcome ?? "open"}</td>
                        <td style={{ color: t.realized_pnl != null ? pnlColor(Number(t.realized_pnl)) : T.muted }}>{t.realized_pnl != null ? fmtSignedMoney(Number(t.realized_pnl)) : "—"}</td>
                        <td style={{ color: T.textSub }}>{dateTime(t.executed_at)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "research" && (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
            <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Crypto research candidates</h2>
            {(members ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13 }}>Awaiting the first crypto research collection.</p> : (members ?? []).map((member: any) => {
              const symbol = member.symbol;
              const shadow = latestShadowBySymbol.get(symbol);
              const score = shadow?.geometry?.score;
              const evidence = shadow?.geometry?.evidence;
              const detail = member.admitted
                ? `Ready for paper evaluation · ${member.history_days} daily bars · spread ${pct(member.spread_pct)}`
                : `Not ready: ${member.refusal_reason ?? "research data incomplete"}`;
              return (
                <div key={symbol} style={{ padding: "10px 0", borderTop: `1px solid ${T.border}`, display: "grid", gridTemplateColumns: "90px 1fr auto", gap: 8, alignItems: "center" }}>
                  <strong><SymbolLink symbol={symbol} style={{ color: T.text }} /></strong>
                  <span style={{ fontSize: 12, color: T.textSub }}>{detail}{evidence?.sessionDate ? ` · session ${evidence.sessionDate}` : ""}</span>
                  <span style={{ color: member.admitted && score?.ok ? T.green : T.amber, fontWeight: 700 }}>{member.admitted && score?.ok ? Number(score.score).toFixed(1) : member.admitted ? "Ready" : "Waiting"}</span>
                </div>
              );
            })}
            <p style={{ margin: "12px 0 0", color: T.muted, fontSize: 11, lineHeight: 1.45 }}>Research is separate from equities. This list explains coverage and data readiness; the paper trader evaluates eligible crypto signals automatically. Live orders remain off.</p>
            <p style={{ margin: "8px 0 0", color: T.muted, fontSize: 11 }}>Coverage: {readiness} · Status: {latestUniverse ? latestUniverse.status : "Not run"}</p>
          </div>
        )}

        {tab === "strategy" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 16 }}>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
              <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Geometry shadows</h2>
              {(shadows ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.5 }}>No native geometry shadows yet. The next collector will record refusal reasons as carefully as eligible setups; no result will be silently treated as a trade.</p> : shadows.map((shadow: any) => (
                <div key={`${shadow.symbol}-${shadow.observed_at}`} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0", display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div><strong><SymbolLink symbol={shadow.symbol} style={{ color: T.text }} /></strong><div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{shadow.strategy_version} · {dateTime(shadow.observed_at)}</div></div>
                  <div style={{ color: shadow.decision === "eligible" ? T.green : T.amber, fontSize: 12, textAlign: "right" }}>{shadow.decision}{shadow.refusal_reason ? `: ${shadow.refusal_reason}` : ""}</div>
                </div>
              ))}
            </div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18 }}>
              <h2 style={{ margin: "0 0 12px", color: T.text, fontSize: 15 }}>Crypto strategy genome</h2>
              {(strategies ?? []).length === 0 ? <p style={{ color: T.muted, fontSize: 13, lineHeight: 1.5 }}>No crypto genome has been promoted. This is correct: the platform must first collect shadow outcomes under a separate crypto strategy namespace.</p> : strategies.map((strategy: any) => (
                <div key={strategy.version} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0", display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div><strong>{strategy.version}</strong><div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>{dateTime(strategy.created_at)}</div></div>
                  <span style={{ color: strategy.is_champion ? T.green : T.textSub, fontSize: 12 }}>{strategy.state}{strategy.is_champion ? " · champion" : ""}</span>
                </div>
              ))}
              <p style={{ margin: "12px 0 0", color: T.muted, fontSize: 11, lineHeight: 1.45 }}>No leverage, martingale, averaging down, or automatic live promotion is permitted by this genome.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
