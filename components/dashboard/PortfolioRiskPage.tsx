"use client";
import { useState, useEffect, useCallback } from "react";
import PageHeader from "./PageHeader";
import RhReconnectBanner from "@/components/dashboard/RhReconnectBanner";
import { useMarket } from "@/lib/market-context";
import { fmtMoney } from "@/lib/format-money";
import type { RiskMetrics, HoldingWithRisk, SectorBreakdown } from "@/lib/portfolio-risk";
import { researchStateSentence, STALE_AFTER_SESSIONS, type ResearchBlock, type ResearchState } from "@/lib/research/risk-annotation";

// The `cur` symbol in this file is always "$" or "₹"; map it to the market so ₹
// book values group lakh/crore-style (₹12,34,567) while $ stays en-US thousands.
const mktOf = (cur: string): "us" | "india" => (cur === "₹" ? "india" : "us");

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", orange: "#F97316", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00", redBg: "#3B0000",
};

type AccountPill = {
  source: string;
  accountId?: string;
  accountLabel?: string;
  totalValue: number;
  cashBalance: number;
  holdingCount: number;
  fetchedAt?: string;
  error?: string;
};

type AccountRisk = {
  accountId: string;
  accountLabel: string;
  source: string;
  totalValue: number;
  cashBalance: number;
  error?: string;
  risk: RiskMetrics;
};

function severityColor(s: string) {
  return s === "critical" ? T.red : s === "warn" ? T.amber : T.sub;
}
function severityBg(s: string) {
  return s === "critical" ? T.redBg : s === "warn" ? T.amberBg : "#1A1D27";
}
function betaColor(b: number) {
  return b > 1.5 ? T.red : b > 1.2 ? T.amber : b > 0.8 ? T.green : T.sub;
}

function Bar({ pct, color, maxPct = 1 }: { pct: number; color: string; maxPct?: number }) {
  const width = Math.min(100, (pct / maxPct) * 100);
  return (
    <div style={{ height: "6px", background: T.border, borderRadius: "3px", overflow: "hidden", flex: 1 }}>
      <div style={{ height: "100%", width: `${width}%`, background: color, borderRadius: "3px", transition: "width 0.5s ease" }} />
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", flex: 1, minWidth: "130px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>{label}</div>
      <div style={{ fontSize: "20px", fontWeight: 700, color: color ?? T.text }}>{value}</div>
      {sub && <div style={{ fontSize: "11px", color: T.sub, marginTop: "3px" }}>{sub}</div>}
    </div>
  );
}

function HoldingsTable({ holdings, risk, cur }: { holdings: HoldingWithRisk[]; risk: RiskMetrics; cur: string }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
        <thead>
          <tr style={{ color: T.muted, borderBottom: `1px solid ${T.border}` }}>
            {["Symbol", "Sector", "Value", "Weight", "Beta", "P&L"].map(h => (
              <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {holdings.map((h, i) => {
            const pnlColor = (h.unrealizedPnl ?? 0) >= 0 ? T.green : T.red;
            const weightColor = h.weightPct > 0.20 ? T.red : h.weightPct > 0.15 ? T.amber : T.text;
            return (
              <tr key={`${h.symbol}-${i}`} style={{ borderBottom: `1px solid ${T.border}44` }}>
                <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>{h.symbol}</td>
                <td style={{ padding: "8px 10px", color: T.sub }}>{h.sector}</td>
                <td style={{ padding: "8px 10px", color: T.text }}>{fmtMoney(h.marketValue, mktOf(cur), 0)}</td>
                <td style={{ padding: "8px 10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ color: weightColor, fontWeight: 600, width: "36px" }}>{(h.weightPct * 100).toFixed(1)}%</span>
                    <Bar pct={h.weightPct} color={weightColor} maxPct={0.25} />
                  </div>
                </td>
                <td style={{ padding: "8px 10px", color: (risk.betaComingSoon || h.beta == null) ? T.muted : betaColor(h.beta) }}>
                  {(risk.betaComingSoon || h.beta == null) ? "—" : h.beta.toFixed(2)}
                </td>
                <td style={{ padding: "8px 10px", color: pnlColor }}>
                  {h.unrealizedPnl != null
                    ? `${(h.unrealizedPnl ?? 0) >= 0 ? "+" : "−"}${fmtMoney(Math.abs(h.unrealizedPnl ?? 0), mktOf(cur), 0)} (${(h.unrealizedPnlPct ?? 0) >= 0 ? "+" : ""}${((h.unrealizedPnlPct ?? 0)).toFixed(1)}%)`
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SectorSection({ breakdown, isIndia, cur }: { breakdown: SectorBreakdown[]; isIndia: boolean; cur: string }) {
  if (!breakdown.length) return null;
  return (
    <div style={{ marginTop: "16px" }}>
      {/* The denominator is NOT decorative: the owner's sector cap is enforced on
          NAV, so a bar labelled "% of invested" is not the number the cap acts on.
          The label follows `basis` — never hardcode it. */}
      <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "10px" }}>
        {isIndia ? "Sector Allocation" : "Sector Allocation vs S&P 500"}
        {breakdown[0]?.basis === "nav" ? " (% of NAV · matches sector cap)" : " (% of invested holdings · NAV unavailable)"}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {breakdown.map(s => {
          const overColor = isIndia ? T.accent : (s.overweightPct > 0.15 ? T.red : s.overweightPct > 0.05 ? T.amber : T.green);
          return (
            <div key={s.sector}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px", fontSize: "11px" }}>
                <span style={{ color: T.text }}>{s.sector}</span>
                <div style={{ display: "flex", gap: "10px" }}>
                  <span style={{ color: overColor, fontWeight: 700 }}>{(s.weightPct * 100).toFixed(0)}%</span>
                  {!isIndia && <span style={{ color: T.muted }}>S&P {(s.sp500WeightPct * 100).toFixed(0)}%</span>}
                  <span style={{ color: T.muted }}>{s.holdingCount}×</span>
                </div>
              </div>
              <Bar pct={s.weightPct} color={overColor} maxPct={0.70} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AccountRiskSection({ ar, isIndia }: { ar: AccountRisk; isIndia: boolean }) {
  const cur = isIndia ? "₹" : "$";
  const risk = ar.risk;
  const [expanded, setExpanded] = useState(true);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", marginBottom: "16px", overflow: "hidden" }}>
      {/* Header */}
      <div
        style={{ padding: "14px 20px", display: "flex", alignItems: "center", gap: "12px", cursor: "pointer", borderBottom: expanded ? `1px solid ${T.border}` : "none" }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>{ar.accountLabel}</div>
          {ar.error
            ? <div style={{ fontSize: "11px", color: T.red, marginTop: "2px" }}>{ar.error.slice(0, 80)}</div>
            : (
              <div style={{ fontSize: "11px", color: T.sub, marginTop: "2px" }}>
                {fmtMoney(ar.totalValue, mktOf(cur), 0)} equity
                · {risk.holdingCount} positions
                · {fmtMoney(ar.cashBalance, mktOf(cur), 0)} cash
              </div>
            )}
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          {!ar.error && (
            <>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>Health</div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: (100 - risk.riskScore) >= 66 ? T.green : (100 - risk.riskScore) >= 50 ? T.amber : T.red }}>{100 - risk.riskScore}/100</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>Risk</div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: risk.riskColor }}>{risk.riskScore}/100</div>
              </div>
              {!risk.betaComingSoon && (
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>Beta</div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: betaColor(risk.portfolioBeta) }}>β {risk.portfolioBeta.toFixed(2)}</div>
                </div>
              )}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>Factor loss</div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: T.amber }}>−{fmtMoney(risk.var95_dollar, mktOf(cur), 0)}</div>
              </div>
            </>
          )}
          <span style={{ color: T.muted, fontSize: "16px" }}>{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {expanded && !ar.error && risk.holdingCount > 0 && (
        <div style={{ padding: "16px 20px" }}>
          {/* Warnings */}
          {risk.warnings.length > 0 && (
            <div style={{ marginBottom: "14px", display: "flex", flexDirection: "column", gap: "6px" }}>
              {risk.warnings.map((w, i) => (
                <div key={i} style={{ background: severityBg(w.severity), border: `1px solid ${severityColor(w.severity)}33`, borderRadius: "8px", padding: "10px 14px" }}>
                  <div style={{ fontSize: "12px", color: severityColor(w.severity), fontWeight: 600 }}>
                    {w.severity === "critical" ? "🔴" : "🟡"} {w.message}
                  </div>
                  {w.action && <div style={{ fontSize: "11px", color: T.sub, marginTop: "3px" }}>→ {w.action}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Holdings table */}
          <HoldingsTable holdings={risk.holdings} risk={risk} cur={cur} />

          {/* Sector breakdown */}
          <SectorSection breakdown={risk.sectorBreakdown} isIndia={isIndia} cur={cur} />

          {/* Correlated pairs */}
          {risk.correlatedPairs.length > 0 && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "8px" }}>Correlated Pairs</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {risk.correlatedPairs.map(p => {
                  const c = p.severity === "high" ? T.red : T.amber;
                  return (
                    <div key={`${p.symbol1}:${p.symbol2}`} style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: p.severity === "high" ? T.redBg : T.amberBg, border: `1px solid ${c}33`, borderRadius: "6px", flexWrap: "wrap", fontSize: "12px" }}>
                      <span style={{ fontWeight: 700, color: T.text }}>{p.symbol1}</span>
                      <span style={{ color: T.muted }}>+</span>
                      <span style={{ fontWeight: 700, color: T.text }}>{p.symbol2}</span>
                      <span style={{ marginLeft: "auto", color: c, fontWeight: 700 }}>{(p.correlation * 100).toFixed(0)}% corr</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Health History — driven by GET /api/portfolio/health-history.
// Health = 100 − riskScore per account per day. Sparkline + delta + top action.
// ─────────────────────────────────────────────────────────────────────────────

type HealthSeries = { date: string; health: number | null; risk: number | null; label: string | null };
type HealthAccount = {
  accountId: string; label: string; broker: string; readOnly: boolean;
  latestHealth: number | null; latestRisk: number | null; latestLabel: string | null;
  deltaVsPrior: number | null;
  topAction: { message: string; action: string; severity: string } | null;
  series: HealthSeries[];
};
type HealthHistoryData = { market: string; firstDay: string | null; accounts: HealthAccount[] };

function Sparkline({ series, id }: { series: HealthSeries[]; id: string }) {
  const vals = series.filter(s => s.health != null);
  if (vals.length < 2) return <span style={{ fontSize: "10px", color: T.muted }}>accruing…</span>;
  const W = 100, H = 28, PAD = 2;
  const xStep = (W - PAD * 2) / (vals.length - 1);
  const yOf = (v: number) => PAD + (H - PAD * 2) * (1 - v / 100);
  const pts = vals.map((s, i) => `${(PAD + i * xStep).toFixed(1)},${yOf(s.health as number).toFixed(1)}`);
  const lastX = +(PAD + (vals.length - 1) * xStep).toFixed(1);
  const lastY = +yOf(vals[vals.length - 1].health as number).toFixed(1);
  const lh = vals[vals.length - 1].health as number;
  const lc = lh >= 66 ? T.green : lh >= 50 ? T.amber : T.red;
  const gId = `sg${id.replace(/[^a-zA-Z0-9]/g, "")}`;
  const areaD = `M ${pts[0]} ${pts.slice(1).map(p => `L ${p}`).join(" ")} L ${lastX},${H} L ${PAD},${H} Z`;
  return (
    <svg width={W} height={H} style={{ display: "block", flexShrink: 0 }}>
      <defs>
        <linearGradient id={gId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={lc} stopOpacity="0.25" />
          <stop offset="100%" stopColor={lc} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gId})`} />
      <polyline points={pts.join(" ")} fill="none" stroke={lc} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="2.5" fill={lc} />
    </svg>
  );
}

function HealthHistoryPanel({ market }: { market: string }) {
  const [data, setData] = useState<HealthHistoryData | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true); setErr(""); setData(null);
    fetch(`/api/portfolio/health-history?market=${market}`)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(j => { if (live) setData(j); })
      .catch(e => { if (live) setErr(e.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [market]);

  if (loading) return <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>Loading health history…</div>;
  if (err) return <div style={{ color: T.red, fontSize: "13px", padding: "8px 0" }}>Health history unavailable: {err.slice(0, 120)}</div>;
  if (!data || !data.accounts.length) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 18px", color: T.muted, fontSize: "13px", marginBottom: "20px" }}>
        No account health history yet. Accrues daily after each risk cron run.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: "24px" }}>
      {data.firstDay && (
        <div style={{ fontSize: "10px", color: T.muted, marginBottom: "10px" }}>
          History from {data.firstDay} · accrues daily going forward
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {data.accounts.map(acc => {
          const h = acc.latestHealth;
          const hColor = h == null ? T.muted : h >= 66 ? T.green : h >= 50 ? T.amber : T.red;
          const delta = acc.deltaVsPrior;
          const deltaColor = delta == null ? T.muted : delta > 0 ? T.green : delta < 0 ? T.red : T.muted;
          return (
            <div key={acc.accountId} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: "120px" }}>
                  <div style={{ fontSize: "12px", fontWeight: 700, color: T.text, display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
                    {acc.label}
                    {acc.readOnly && <span style={{ fontSize: "9px", color: T.amber, fontWeight: 600 }}>read-only</span>}
                    {acc.broker === "internal" && <span style={{ fontSize: "9px", color: T.accent, fontWeight: 600 }}>paper</span>}
                  </div>
                  {acc.topAction && (
                    <div style={{ fontSize: "11px", color: acc.topAction.severity === "critical" ? T.red : T.amber, marginTop: "4px", lineHeight: 1.4 }}>
                      {acc.topAction.severity === "critical" ? "🔴" : "🟡"} {acc.topAction.message}
                      {acc.topAction.action && <span style={{ color: T.muted }}> → {acc.topAction.action}</span>}
                    </div>
                  )}
                  {!acc.topAction && acc.latestLabel && (
                    <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px" }}>{acc.latestLabel}</div>
                  )}
                </div>
                <Sparkline series={acc.series} id={acc.accountId} />
                <div style={{ textAlign: "right", minWidth: "60px" }}>
                  <div style={{ fontSize: "18px", fontWeight: 700, color: hColor, fontVariantNumeric: "tabular-nums" }}>
                    {h == null ? "—" : `${h}`}<span style={{ fontSize: "11px", color: T.muted, fontWeight: 400 }}>/100</span>
                  </div>
                  <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Health</div>
                  {delta != null && (
                    <div style={{ fontSize: "10px", color: deltaColor, fontVariantNumeric: "tabular-nums" }}>
                      {delta > 0 ? "+" : ""}{delta} vs prior
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
type EarningsRiskView = {
  policyMode: "shadow";
  behaviorChanged: false;
  holdings: Array<{
    symbol: string;
    reportDate: string | null;
    reportSession: string;
    sessionsUntilReport: number | null;
    optionsQuality: string;
    moveProxyPct: number | null;
    stopToMoveRatio: number | null;
  }>;
  measurement: {
    entryDecisions: number;
    distinctEvents: number;
    requiredEntryDecisions: number;
    requiredDistinctEvents: number;
  };
};

function EarningsRiskPanel({ market }: { market: string }) {
  const [data, setData] = useState<EarningsRiskView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setError("");
    fetch(`/api/portfolio/earnings-risk?market=${market}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      })
      .then((json) => { if (live) setData(json); })
      .catch((reason) => { if (live) setError(String(reason?.message ?? reason)); });
    return () => { live = false; };
  }, [market]);
  if (error) {
    return <div style={{ color: T.red, fontSize: "12px", marginBottom: "20px" }}>Earnings risk unavailable: {error.slice(0, 120)}</div>;
  }
  if (!data) return <div style={{ color: T.muted, fontSize: "12px", marginBottom: "20px" }}>Loading earnings risk...</div>;
  const upcoming = data.holdings.filter((row) =>
    row.sessionsUntilReport != null && row.sessionsUntilReport >= 0 && row.sessionsUntilReport <= 20);
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px 16px", marginBottom: "22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", marginBottom: "10px" }}>
        <div>
          <div style={{ color: T.text, fontSize: "13px", fontWeight: 700 }}>Earnings Event Risk</div>
          <div style={{ color: T.muted, fontSize: "10px", marginTop: "3px" }}>
            Shadow only. These warnings do not change trades, stops, targets, or exits.
          </div>
        </div>
        <div style={{ color: T.sub, fontSize: "10px" }}>
          Evidence {data.measurement.entryDecisions}/{data.measurement.requiredEntryDecisions} entries · {data.measurement.distinctEvents}/{data.measurement.requiredDistinctEvents} events
        </div>
      </div>
      {upcoming.length === 0 ? (
        <div style={{ color: T.muted, fontSize: "12px" }}>No cached earnings event within 20 sessions for current holdings.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ color: T.muted, borderBottom: `1px solid ${T.border}` }}>
                {["Symbol", "Report", "Sessions", "Move proxy", "Stop / move", "Quality"].map((label) => (
                  <th key={label} style={{ textAlign: "left", padding: "6px 8px", fontWeight: 600 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {upcoming.map((row) => (
                <tr key={row.symbol} style={{ borderBottom: `1px solid ${T.border}55` }}>
                  <td style={{ padding: "7px 8px", color: T.text, fontWeight: 700 }}>{row.symbol}</td>
                  <td style={{ padding: "7px 8px", color: T.sub }}>{row.reportDate} · {row.reportSession}</td>
                  <td style={{ padding: "7px 8px", color: (row.sessionsUntilReport ?? 99) <= 5 ? T.amber : T.text }}>{row.sessionsUntilReport}</td>
                  <td style={{ padding: "7px 8px", color: T.text }}>{row.moveProxyPct == null ? "—" : `${(row.moveProxyPct * 100).toFixed(1)}%`}</td>
                  <td style={{ padding: "7px 8px", color: row.stopToMoveRatio != null && row.stopToMoveRatio < 1 ? T.amber : T.text }}>
                    {row.stopToMoveRatio == null ? "—" : `${row.stopToMoveRatio.toFixed(2)}x`}
                  </td>
                  <td style={{ padding: "7px 8px", color: row.optionsQuality === "usable" ? T.green : T.muted }}>{row.optionsQuality}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Daily Per-Holding Risk — driven by GET /api/portfolio/risk-daily. Deterministic
// score + posture from the daily snapshot; the strategy_note is LLM prose that
// cannot change either. Never aggregates across accounts or currencies. This is a
// historical daily run, wholly separate from the live "↻ Refresh" above.
// ─────────────────────────────────────────────────────────────────────────────

type DailyAccount = {
  accountId: string;
  label: string | null;
  broker: string;
  currency: string;
  capturedOn: string;
  sourceCapturedAt: string | null;
  completedAt: string | null;
  formulaVersion: string;
  dataConfidence: number | null;
};

type DailyHolding = {
  symbol: string; source: string | null; sector: string | null;
  qty: number | null; current_price: number | null; average_cost: number | null;
  market_value: number | null; weight_pct: number | null; beta: number | null;
  realized_vol_pct: number | null; unrealized_pnl_pct: number | null;
  holding_risk_score: number | null; risk_label: string | null;
  risk_drivers: any; risk_posture: string | null; action_reason: string | null;
  source_risk_posture?: string | null;
  add_capacity: boolean | null; data_confidence: number | null;
  missing_inputs: string[] | null; strategy_note: string | null;
  // Research annotation — DISPLAY ONLY. Never read by any risk decision (R1).
  // null = the research read failed; a block with state 'never' = read succeeded,
  // no signal exists. Different facts, rendered differently.
  research?: ResearchBlock | null;
};

type DailyRun = {
  runId: string; capturedOn: string; currency: string; broker: string;
  accountLabel: string | null; sourceCapturedAt: string | null; completedAt: string | null;
  formulaVersion: string; dataConfidence: number | null; missingInputs: string[];
  account: { metrics?: any; total_value?: number | null } | null;
  holdings: DailyHolding[];
  // Fail-soft: false means the agent_signals read failed. The risk table still
  // renders — research absence must never blank the product.
  researchAvailable?: boolean;
  researchUnavailableReason?: string | null;
};

const CUR_SYMBOL: Record<string, string> = { USD: "$", INR: "₹" };

function scoreColor(s: number | null): string {
  if (s == null) return T.muted;
  return s >= 75 ? T.red : s >= 50 ? T.orange : s >= 25 ? T.amber : T.green;
}

const POSTURE: Record<string, { label: string; color: string; bg: string }> = {
  hold:              { label: "Hold",         color: T.green,  bg: T.greenBg },
  review:            { label: "Review",       color: T.amber,  bg: T.amberBg },
  trim:              { label: "Trim",         color: T.orange, bg: "#2A1400" },
  exit_review:       { label: "Exit review",  color: T.red,    bg: T.redBg },
  insufficient_data: { label: "No data",      color: T.muted,  bg: "#1A1D27" },
};
function postureOf(p: string | null) {
  return POSTURE[p ?? ""] ?? { label: p ?? "—", color: T.sub, bg: "#1A1D27" };
}

// Robinhood 965848641 is read-only per CONNECTIONS.md — a trim/exit there is
// informational, no order path exists. Everything in this feature is advisory,
// but read-only accounts get the explicit badge.
function isReadOnlyAccount(broker: string, accountId: string): boolean {
  return broker === "robinhood" && accountId !== "605420660";
}
function dailyAccountLabel(account: DailyAccount): string {
  return account.broker === "internal" ? "Paper Portfolio" : (account.label ?? account.accountId);
}

function ScoreChip({ score }: { score: number | null }) {
  const c = scoreColor(score);
  return (
    <span style={{ display: "inline-block", minWidth: "42px", textAlign: "center", padding: "2px 8px", borderRadius: "6px", background: `${c}22`, border: `1px solid ${c}55`, color: c, fontWeight: 700, fontSize: "12px", fontVariantNumeric: "tabular-nums" }}>
      {score == null ? "—" : score}
    </span>
  );
}
function PosturePill({ posture }: { posture: string | null }) {
  const p = postureOf(posture);
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: "999px", background: p.bg, border: `1px solid ${p.color}55`, color: p.color, fontWeight: 600, fontSize: "11px" }}>
      {p.label}
    </span>
  );
}

// ── Research annotation cell ────────────────────────────────────────────────
// DISPLAY ONLY. This annotates the SCORE, never the risk action or verdict —
// dimming a posture because research is stale would edge toward the coupling
// this feature deliberately refuses (owner decision Q2, 2026-07-17).
//
// The age is the point. On 2026-07-16 AVGO showed a confident-looking 91 that was
// six days old while the Action column said "trim", and the screen gave the owner
// no way to know. Staleness is computed in market-local SESSIONS server-side and
// shown in DAYS here, because "3 days" reads plainly and "1 session" does not.

const RESEARCH_STATE_COLOR: Record<ResearchState, string> = {
  fresh: T.sub,
  stale: T.amber,      // a warning, not an error — the score may still be right
  never: T.muted,
  unavailable: T.muted,
};

function researchJournalHref(symbol: string, market: string): string {
  return `/dashboard/research-journal?symbol=${encodeURIComponent(symbol)}&market=${encodeURIComponent(market)}`;
}

function directionLabel(d: string | null): string {
  return d === "long" ? "Long" : d === "short" ? "Short" : d === "neutral" ? "Neutral" : "—";
}

/** Compact cell for the table: score + age badge. Everything else lives in the expander (mobile-first, Q4). */
function ResearchCell({ research, available, symbol, market }: {
  research: ResearchBlock | null | undefined;
  available: boolean;
  symbol: string;
  market: string;
}) {
  // Fail-soft: the read failed. Say so — never a blank, never a fake score.
  if (!available) {
    return <span title="The research signal store could not be read. The risk figures on this row are unaffected — they are computed without research by design." style={{ fontSize: "11px", color: T.muted }}>research unavailable</span>;
  }
  if (!research || research.state === "never") {
    // NOT a link — a link to nothing is a lie.
    return <span title="Research has no signal on record for this symbol in this market. This is different from a stale score: there is nothing, not something old." style={{ fontSize: "11px", color: T.muted }}>never scored</span>;
  }
  if (research.state === "unavailable") {
    // Never render an abstain as a number.
    return <span title="Research ran but abstained on thin evidence — there is no score to show. An abstain is not a zero and not a 50." style={{ fontSize: "11px", color: T.muted }}>abstained</span>;
  }

  const stale = research.state === "stale";
  const c = RESEARCH_STATE_COLOR[research.state];
  const d = research.days_since;
  const age = d == null ? "age unknown" : d === 0 ? "today" : `${d}d ago`;

  return (
    <a
      href={researchJournalHref(symbol, market)}
      onClick={e => e.stopPropagation()}
      title={researchStateSentence(research)}
      style={{ display: "inline-flex", alignItems: "center", gap: "6px", textDecoration: "none" }}
    >
      <span style={{ fontWeight: 700, fontSize: "12px", color: T.text, fontVariantNumeric: "tabular-nums" }}>{research.score}</span>
      <span style={{
        fontSize: "9px", fontWeight: 700, padding: "1px 5px", borderRadius: "4px",
        background: `${c}22`, border: `1px solid ${c}55`, color: c, whiteSpace: "nowrap",
      }}>
        {stale ? `⚠ ${age}` : age}
      </span>
    </a>
  );
}

/**
 * Expander detail: direction + how the score was produced. Per Q4 (mobile-first)
 * the table cell carries only score + age badge; this is where the rest lives.
 */
function ResearchDetail({ research, available, reason, symbol, market }: {
  research: ResearchBlock | null | undefined;
  available: boolean;
  reason: string | null;
  symbol: string;
  market: string;
}) {
  const Wrap = ({ children }: { children: React.ReactNode }) => (
    <div style={{ marginTop: "10px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 12px" }}>
      <div style={{ fontSize: "9px", color: T.sub, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>
        Research (advisory context — does not affect the score or action above)
      </div>
      {children}
    </div>
  );

  if (!available) {
    return (
      <Wrap>
        <div style={{ fontSize: "12px", color: T.amber, lineHeight: 1.5 }}>
          Research unavailable — the signal store could not be read{reason ? `: ${reason.slice(0, 120)}` : ""}. The risk score and action on this
          row are unaffected: they are computed without research by design.
        </div>
      </Wrap>
    );
  }
  if (!research || research.state === "never") {
    return (
      <Wrap>
        <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.5 }}>
          Never scored — research has no signal on record for {symbol} in this market. That is not the same as a stale score: there is nothing here, not
          something old. No research-journal entry exists to link to.
        </div>
      </Wrap>
    );
  }
  if (research.state === "unavailable") {
    return (
      <Wrap>
        <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.5 }}>
          Research ran but abstained on thin evidence — there is no score to show. An abstain is not a zero and not a neutral 50.
        </div>
      </Wrap>
    );
  }

  const stale = research.state === "stale";
  // The trap: `is_holding` changes what the score MEANS. Every agent_signals row
  // in prod is is_holding:false — scored as a screener CANDIDATE, not as a
  // holding. The direction gate can only emit `short` (a deterministic exit) when
  // the symbol was scored as held, so a `neutral` from the screener path does NOT
  // mean "no exit signal" — it means the exit question was never asked.
  const asHolding = research.scored_as_holding === true;

  return (
    <Wrap>
      <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", alignItems: "center", marginBottom: "6px" }}>
        <span style={{ fontSize: "12px", color: T.text }}>
          Score <b style={{ fontVariantNumeric: "tabular-nums" }}>{research.score}</b>
        </span>
        <span style={{ fontSize: "12px", color: T.sub }}>Direction <b style={{ color: T.text }}>{directionLabel(research.direction)}</b></span>
        <span style={{ fontSize: "12px", color: stale ? T.amber : T.sub }}>{researchStateSentence(research)}</span>
      </div>
      <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.5 }}>
        {asHolding
          ? "Scored as a HOLDING — the exit question was asked of this position."
          : `Scored as a screener CANDIDATE, not as a holding${research.direction === "neutral" ? " — so \"Neutral\" here does not mean \"no exit signal\"; the exit question was never asked of this position" : ""}.`}
      </div>
      {stale && (
        <div style={{ fontSize: "11px", color: T.amber, marginTop: "6px", lineHeight: 1.5 }}>
          This score predates the last {STALE_AFTER_SESSIONS} trading sessions in this market. Staleness is counted in market-local sessions, not
          calendar days, so weekends and holidays do not inflate it.
        </div>
      )}
      <a href={researchJournalHref(symbol, market)} onClick={e => e.stopPropagation()}
        style={{ display: "inline-block", marginTop: "8px", fontSize: "11px", color: T.accent, textDecoration: "none" }}>
        View research journal entry for {symbol} →
      </a>
    </Wrap>
  );
}

function DailyHoldingRow({ h, prevScore, cur, market, researchAvailable, researchReason }: {
  h: DailyHolding; prevScore: number | null; cur: string; market: string;
  researchAvailable: boolean; researchReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  const insufficient = h.risk_posture === "insufficient_data" || h.holding_risk_score == null;
  const delta = (h.holding_risk_score != null && prevScore != null) ? h.holding_risk_score - prevScore : null;
  const deltaColor = delta == null ? T.muted : delta > 0 ? T.red : delta < 0 ? T.green : T.muted;
  const drivers: Array<{ label?: string; component?: string; points?: number; detail?: string }> =
    Array.isArray(h.risk_drivers) ? h.risk_drivers
    : (h.risk_drivers && Array.isArray(h.risk_drivers.components)) ? h.risk_drivers.components
    : [];

  return (
    <>
      <tr onClick={() => setOpen(o => !o)} style={{ borderBottom: `1px solid ${T.border}44`, cursor: "pointer" }}>
        <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>
          <span style={{ color: T.muted, marginRight: "6px", fontSize: "10px" }}>{open ? "▾" : "▸"}</span>{h.symbol}
        </td>
        <td className="hide-narrow" style={{ padding: "8px 10px", color: T.sub }}>{h.sector ?? "—"}</td>
        <td className="hide-narrow" style={{ padding: "8px 10px", color: T.text, fontVariantNumeric: "tabular-nums" }}>
          {h.market_value != null ? fmtMoney(h.market_value, mktOf(cur), 0) : "—"}
        </td>
        <td className="hide-narrow" style={{ padding: "8px 10px", color: T.text, fontVariantNumeric: "tabular-nums" }}>
          {h.weight_pct != null ? `${(h.weight_pct * 100).toFixed(1)}%` : "—"}
        </td>
        <td style={{ padding: "8px 10px" }}><ScoreChip score={h.holding_risk_score} /></td>
        <td style={{ padding: "8px 10px" }}><PosturePill posture={h.risk_posture} /></td>
        <td className="hide-narrow" style={{ padding: "8px 10px", color: deltaColor, fontVariantNumeric: "tabular-nums", fontSize: "11px" }}>
          {delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta}`}
        </td>
        <td style={{ padding: "8px 10px" }}>
          <ResearchCell research={h.research} available={researchAvailable} symbol={h.symbol} market={market} />
        </td>
      </tr>
      {open && (
        <tr style={{ background: T.surface }}>
          <td colSpan={8} style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
            {insufficient && (
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "8px" }}>
                Insufficient data to score this holding{h.missing_inputs?.length ? ` — missing: ${h.missing_inputs.join(", ")}` : ""}.
              </div>
            )}
            {h.action_reason && (
              <div style={{ fontSize: "12px", color: postureOf(h.risk_posture).color, marginBottom: "8px" }}>
                → {h.action_reason}
              </div>
            )}
            {drivers.length > 0 && (
              <div style={{ marginBottom: "10px" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "6px" }}>Risk drivers</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  {drivers.map((d, i) => (
                    <div key={i} style={{ fontSize: "12px", color: T.sub, display: "flex", gap: "8px" }}>
                      <span style={{ color: T.text }}>{d.label ?? d.component ?? "—"}</span>
                      {d.points != null && <span style={{ color: scoreColor(d.points * 5), fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>+{d.points}</span>}
                      {d.detail && <span style={{ color: T.muted }}>{d.detail}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {h.strategy_note && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 12px" }}>
                <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>Strategy note (advisory)</div>
                <div style={{ fontSize: "12px", color: T.text, lineHeight: 1.5 }}>{h.strategy_note}</div>
              </div>
            )}

            <ResearchDetail research={h.research} available={researchAvailable}
              reason={researchReason} symbol={h.symbol} market={market} />
            <div style={{ fontSize: "10px", color: T.muted, marginTop: "8px", display: "flex", gap: "14px", flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
              {h.beta != null && <span>β {h.beta.toFixed(2)}</span>}
              {h.realized_vol_pct != null && <span>vol {h.realized_vol_pct.toFixed(1)}%</span>}
              {h.unrealized_pnl_pct != null && <span style={{ color: h.unrealized_pnl_pct >= 0 ? T.green : T.red }}>P&L {h.unrealized_pnl_pct >= 0 ? "+" : ""}{h.unrealized_pnl_pct.toFixed(1)}%</span>}
              {h.data_confidence != null && <span>confidence {(h.data_confidence * 100).toFixed(0)}%</span>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DailyHoldingRiskPanel({ market }: { market: string }) {
  const [accounts, setAccounts] = useState<DailyAccount[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [run, setRun] = useState<{ latest: DailyRun | null; previous: DailyRun | null } | null>(null);
  const [listErr, setListErr] = useState("");
  const [detailErr, setDetailErr] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);

  // Account list (never aggregated across accounts).
  useEffect(() => {
    let live = true;
    setLoadingList(true); setListErr(""); setAccounts(null); setSelected(null); setRun(null);
    fetch(`/api/portfolio/risk-daily?market=${market}`)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(j => { if (!live) return; const accs: DailyAccount[] = j.accounts ?? []; setAccounts(accs); setSelected(accs[0]?.accountId ?? null); })
      .catch(e => { if (live) setListErr(e.message); })
      .finally(() => { if (live) setLoadingList(false); });
    return () => { live = false; };
  }, [market]);

  // Detail for the selected account.
  useEffect(() => {
    if (!selected) { setRun(null); return; }
    let live = true;
    setLoadingDetail(true); setDetailErr("");
    fetch(`/api/portfolio/risk-daily?market=${market}&accountId=${encodeURIComponent(selected)}`)
      .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
      .then(j => { if (live) setRun({ latest: j.latest ?? null, previous: j.previous ?? null }); })
      .catch(e => { if (live) setDetailErr(e.message); })
      .finally(() => { if (live) setLoadingDetail(false); });
    return () => { live = false; };
  }, [selected, market]);

  if (loadingList) {
    return <div style={{ color: T.muted, fontSize: "13px", padding: "8px 0" }}>Loading daily risk snapshots…</div>;
  }
  if (listErr) {
    return <div style={{ color: T.red, fontSize: "13px", padding: "8px 0" }}>Daily risk unavailable: {listErr.slice(0, 120)}</div>;
  }
  if (!accounts || accounts.length === 0) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", color: T.muted, fontSize: "13px" }}>
        No daily risk run yet for this market. The <code style={{ color: T.sub }}>holding-risk</code> cron populates this after each market close.
      </div>
    );
  }

  const selAcc = accounts.find(a => a.accountId === selected) ?? null;
  const latest = run?.latest ?? null;
  const prevBySymbol = new Map<string, number | null>();
  for (const p of run?.previous?.holdings ?? []) prevBySymbol.set(p.symbol, p.holding_risk_score);
  const cur = CUR_SYMBOL[selAcc?.currency ?? latest?.currency ?? "USD"] ?? "$";
  const readOnly = selAcc ? isReadOnlyAccount(selAcc.broker, selAcc.accountId) : false;

  return (
    <div style={{ marginBottom: "28px" }}>
      {/* Account tabs — one currency per tab, never merged */}
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "14px" }}>
        {accounts.map(a => {
          const active = a.accountId === selected;
          const ro = isReadOnlyAccount(a.broker, a.accountId);
          return (
            <button key={a.accountId} onClick={() => setSelected(a.accountId)}
              style={{ background: active ? T.accent + "22" : T.card, border: `1px solid ${active ? T.accent : T.border}`, borderRadius: "8px", padding: "8px 14px", cursor: "pointer", textAlign: "left" }}>
              <div style={{ fontSize: "12px", fontWeight: 700, color: active ? T.text : T.sub }}>
                {dailyAccountLabel(a)}
                {a.broker === "internal" && <span style={{ marginLeft: "6px", fontSize: "9px", color: T.accent, fontWeight: 600 }}>paper</span>}
                {ro && <span style={{ marginLeft: "6px", fontSize: "9px", color: T.amber, fontWeight: 600 }}>read-only</span>}
              </div>
              <div style={{ fontSize: "10px", color: T.muted }}>{CUR_SYMBOL[a.currency] ?? a.currency} · {a.capturedOn}</div>
            </button>
          );
        })}
      </div>

      {loadingDetail && <div style={{ color: T.muted, fontSize: "13px" }}>Loading account snapshot…</div>}
      {detailErr && <div style={{ color: T.red, fontSize: "13px" }}>Snapshot unavailable: {detailErr.slice(0, 120)}</div>}

      {!loadingDetail && !detailErr && latest && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", overflow: "hidden" }}>
          {/* Cadence header: daily, last computed / as-of / formula / confidence */}
          <div style={{ padding: "12px 18px", borderBottom: `1px solid ${T.border}`, display: "flex", flexWrap: "wrap", gap: "16px", alignItems: "center" }}>
            <span style={{ fontSize: "9px", color: T.green, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, border: `1px solid ${T.green}44`, borderRadius: "4px", padding: "2px 6px" }}>Daily</span>
            <span style={{ fontSize: "11px", color: T.sub }}>Last computed <span style={{ color: T.text }}>{latest.capturedOn}</span></span>
            {latest.sourceCapturedAt && <span style={{ fontSize: "11px", color: T.sub }}>Data as of <span style={{ color: T.text }}>{new Date(latest.sourceCapturedAt).toLocaleString()}</span></span>}
            <span style={{ fontSize: "11px", color: T.muted }}>formula {latest.formulaVersion}</span>
            {latest.dataConfidence != null && <span style={{ fontSize: "11px", color: T.muted }}>confidence {(latest.dataConfidence * 100).toFixed(0)}%</span>}
            {readOnly && <span style={{ marginLeft: "auto", fontSize: "10px", color: T.amber, fontWeight: 600 }}>advisory only · no order path</span>}
          </div>

          {latest.missingInputs.length > 0 && (
            <div style={{ padding: "8px 18px", fontSize: "11px", color: T.amber, borderBottom: `1px solid ${T.border}` }}>
              Missing inputs lowered confidence: {latest.missingInputs.join(", ")}
            </div>
          )}

          {/* Mobile-first (owner decision Q4, 2026-07-17): at 375px the table keeps
              Symbol / Risk / Action / Research (score + age badge). Sector, Value,
              Weight and Δ1d drop out; direction and how-it-was-scored live in the
              row expander, which every column already relies on. */}
          <style>{`@media (max-width: 560px) { .hide-narrow { display: none; } }`}</style>

          {latest.holdings.length === 0 ? (
            <div style={{ padding: "20px", color: T.muted, fontSize: "13px" }}>No holdings in this account's snapshot.</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                <thead>
                  <tr style={{ color: T.muted, borderBottom: `1px solid ${T.border}` }}>
                    {[
                      { k: "Symbol" }, { k: "Sector", hideOnMobile: true }, { k: "Value", hideOnMobile: true },
                      { k: "Weight", hideOnMobile: true }, { k: "Risk" }, { k: "Action" },
                      { k: "Δ 1d", hideOnMobile: true },
                      // Research is DISPLAY ONLY and sits after the risk verdict on
                      // purpose: the verdict does not depend on it.
                      { k: "Research", title: "Latest research score and how old it is. Advisory context only — it does not affect the Risk score or the Action, which are computed without research by design." },
                    ].map(h => (
                      <th key={h.k} title={h.title} className={h.hideOnMobile ? "hide-narrow" : undefined}
                        style={{ padding: "8px 10px", textAlign: "left", fontWeight: 600 }}>{h.k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {latest.holdings.map((h, i) => (
                    <DailyHoldingRow key={`${h.symbol}-${i}`} h={h} prevScore={prevBySymbol.get(h.symbol) ?? null} cur={cur}
                      market={market} researchAvailable={latest.researchAvailable !== false}
                      researchReason={latest.researchUnavailableReason ?? null} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ padding: "10px 18px", fontSize: "10px", color: T.muted, borderTop: `1px solid ${T.border}` }}>
            Score is a risk-control pressure index (0–100), not a loss probability or return forecast. Posture and score are deterministic; the strategy note is an LLM explanation and cannot change either. Advisory only — nothing here places or cancels an order.
          </div>
        </div>
      )}

      {!loadingDetail && !detailErr && !latest && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", color: T.muted, fontSize: "13px" }}>
          No complete daily run for this account yet.
        </div>
      )}
    </div>
  );
}

// Plain-language legend so the two scores + posture words are never a mystery.
// Same content as the newsletter legend — one source of truth for "what the
// numbers mean". Collapsed by default (owner asked for info-on-demand, not noise).
function RiskLegend() {
  const [open, setOpen] = useState(false);
  const Item = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <li style={{ marginBottom: "7px", lineHeight: 1.5 }}>
      <span style={{ color: T.text, fontWeight: 700 }}>{k}</span>{" "}
      <span style={{ color: T.sub }}>{children}</span>
    </li>
  );
  const H = ({ children }: { children: React.ReactNode }) => (
    <div style={{ fontSize: "12px", color: T.text, fontWeight: 700, margin: "12px 0 6px" }}>{children}</div>
  );
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", marginBottom: "20px", overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "12px 18px", cursor: "pointer", display: "flex", alignItems: "center", gap: "10px" }}>
        <span style={{ fontSize: "13px", fontWeight: 700, color: T.text }}>❔ What do these numbers mean?</span>
        <span style={{ marginLeft: "auto", color: T.muted, fontSize: "14px" }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && (
        <div style={{ padding: "0 18px 16px", fontSize: "12px" }}>
          <H>The two scores (NOT the same axis)</H>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            <Item k="Conviction (0–100):">how much the research agent likes the stock. Higher = better. This is the ResearchAgent&apos;s analyst score.</Item>
            <Item k="Risk (0–100):">how risky it is to HOLD now — concentration, volatility, correlation. Higher = riskier. A great stock you own too much of is high conviction AND high risk at once.</Item>
            <Item k="Health (0–100):">account-level, = 100 − Risk. Higher = calmer account.</Item>
          </ul>
          <H>Posture words (Action column)</H>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            <Item k="Hold:">within owner-approved limits. No action.</Item>
            <Item k="Review:">a limit (usually single-name concentration) is over its reference. Look at it — but Kairos has no account-specific sell mandate, so it does NOT tell you to trim.</Item>
            <Item k="Trim:">this name was deterministically selected to absorb a sector-cap breach. Advisory.</Item>
            <Item k="Exit review:">a verified protective-stop breach or thesis break. Highest priority.</Item>
            <Item k="No data:">missing structural inputs — no score shown rather than a fake one.</Item>
          </ul>
          <H>What builds the Risk score (6 drivers)</H>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            <Item k="Name concentration (30):">weight vs the 12% single-name reference.</Item>
            <Item k="Sector concentration (20):">sector weight vs the 30% sector reference.</Item>
            <Item k="Volatility / beta (15):">daily vol vs a 4% name reference, plus beta.</Item>
            <Item k="Correlated cluster (15):">how correlated co-held names are, vs the 0.70 reference.</Item>
            <Item k="Drawdown / stop (10):">distance to cost / protective stop. Never triggers an exit on its own.</Item>
            <Item k="Liquidity / event (10):">a fresh news/liquidity flag — an earnings date, a trading halt, or thin volume. Only counts when a live feed was actually queried; otherwise excluded, never assumed safe.</Item>
          </ul>
          <H>Owner-approved risk limits (references in force)</H>
          <ul style={{ margin: 0, paddingLeft: "18px" }}>
            <Item k="Single name ≤ 12%">of account value · <span style={{ color: T.text, fontWeight: 700 }}>Single sector ≤ 30%</span> of NAV.</Item>
            <Item k="Portfolio daily vol ≤ 2%">· avg pairwise correlation ≤ 0.70 · gross exposure ≤ 80%.</Item>
            <Item k="Order authority:">only account ••••0660 can ever place an order; every other account is read-only and advisory.</Item>
          </ul>
        </div>
      )}
    </div>
  );
}

export default function PortfolioRiskPage() {
  const { market } = useMarket();
  const [data, setData] = useState<{
    accounts: AccountPill[];
    risk: RiskMetrics;
    accountRisks: AccountRisk[];
    fetchedAt: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/portfolio/holdings?market=${market}`);
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [market]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: "clamp(12px, 4vw, 28px)", color: T.muted, fontSize: "14px" }}>Fetching holdings from all accounts…</div>;
  if (error)   return <div style={{ padding: "clamp(12px, 4vw, 28px)", color: T.red, fontSize: "14px" }}>Error: {error}</div>;
  if (!data)   return null;

  const { accounts, risk, accountRisks } = data;
  const cur = risk.currency ?? "$";
  const isIndia = risk.market === "india";

  return (
    <div>
      <PageHeader
        title="Portfolio Risk"
        subtitle={isIndia ? "Live ₹ risk analytics across your Kite India account" : "Live risk analytics across all Robinhood accounts"}
        cadence="as-needed"
        whatItDoes="Fetches live US positions through Robinhood MCP and India positions through Kite. Computes per-account and combined concentration risk, market sensitivity, a benchmark-factor loss proxy, and sector exposure."
        whatToLookFor={[
          "Risk score above 75 means you're carrying more risk than most retail portfolios.",
          isIndia
            ? "Large single-sector exposure can make the India book vulnerable to sector-specific shocks."
            : "Sector overweight above 2× vs S&P 500 means a sector crash hits you much harder.",
          "Correlated pairs mean less diversification — holding NVDA + AMD is less safe than it looks.",
          "Per-account sections below show independent risk for each brokerage account.",
        ]}
      />

      <div style={{ padding: "0 clamp(12px, 4vw, 28px) clamp(20px, 5vw, 40px)" }}>

        {!isIndia && <RhReconnectBanner />}

        <RiskLegend />

        {/* Refresh */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
          <button onClick={load} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.sub, padding: "7px 16px", fontSize: "12px", cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

        {/* ── Account Health History ── */}
        <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "4px" }}>
          Account Health History
        </div>
        <div style={{ fontSize: "11px", color: T.muted, marginBottom: "12px" }}>
          Health = 100 − Risk per account, daily. Worst health first. Top warning shown.
        </div>
        <HealthHistoryPanel market={market} />

        <EarningsRiskPanel market={market} />

        {/* ── Daily Per-Holding Risk (historical run, separate from live Refresh) ── */}
        <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "4px" }}>
          Daily Per-Holding Risk
        </div>
        <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>
          Deterministic risk score + posture per holding for each live or paper account, recomputed after each market close. Never merges currencies or accounts.
        </div>
        <DailyHoldingRiskPanel market={market} />

        {/* Account pills */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
          {accounts.map((a, i) => (
            <div key={`${a.source}-${a.accountId ?? i}`} style={{ background: a.error ? T.redBg : T.card, border: `1px solid ${a.error ? T.red + "44" : T.border}`, borderRadius: "8px", padding: "8px 14px", fontSize: "12px" }}>
              <span style={{ color: T.sub }}>{a.accountLabel ?? a.source}</span>
              {a.accountId && isReadOnlyAccount(a.source, a.accountId) && (
                <span style={{ color: T.amber, marginLeft: "6px", fontSize: "9px", fontWeight: 600 }}>read-only</span>
              )}
              {a.error
                ? <span style={{ color: T.red, marginLeft: "8px" }}>— {a.error.slice(0, 120)}</span>
                : (
                  <>
                    <span style={{ color: T.text, fontWeight: 700, marginLeft: "8px" }}>{fmtMoney(a.totalValue, mktOf(cur), 0)}</span>
                    <span style={{ color: T.muted, marginLeft: "6px" }}>· {a.holdingCount} positions</span>
                  </>
                )}
            </div>
          ))}
        </div>

        {risk.holdingCount === 0 ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted }}>
            {isIndia
              ? "No Kite holdings found. Log in to Kite and ensure your daily token is active."
              : "No Robinhood holdings found. Ensure the Robinhood OAuth token is active in Settings → System → API Vault."}
          </div>
        ) : (
          <>
            {/* ── Roll-up: at a glance ── */}
            <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "12px" }}>
              Combined Across All Accounts
            </div>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "20px" }}>
              <StatCard label="Invested Value" value={fmtMoney(risk.totalValue, mktOf(cur), 0)} sub={`${risk.holdingCount} positions · cash excluded`} />
              <StatCard
                label="Account Health"
                value={`${100 - risk.riskScore}/100`}
                sub={`Health = 100 − Risk · higher is calmer`}
                color={(100 - risk.riskScore) >= 66 ? T.green : (100 - risk.riskScore) >= 50 ? T.amber : T.red}
              />
              <StatCard label="Risk Score" value={`${risk.riskScore}/100`} sub={risk.riskLabel} color={risk.riskColor} />
              <StatCard
                label="Market Sensitivity"
                value={risk.betaComingSoon ? "β —" : `β ${risk.portfolioBeta.toFixed(2)}`}
                sub={risk.betaComingSoon
                  ? `beta vs ${risk.benchmarkLabel} — coming soon`
                  : (risk.portfolioBeta > 1 ? `${Math.round((risk.portfolioBeta - 1) * 100)}% more volatile than market` : `${Math.round((1 - risk.portfolioBeta) * 100)}% less volatile than market`)}
                color={risk.betaComingSoon ? T.muted : betaColor(risk.portfolioBeta)}
              />
              <StatCard
                label="1-Day Market-Factor Loss (95%)"
                value={`−${fmtMoney(risk.var95_dollar, mktOf(cur), 0)}`}
                sub={`${(risk.var95_pct * 100).toFixed(1)}% · benchmark-factor proxy, not full VaR`}
                color={T.amber}
              />
            </div>

            {/* Roll-up plain-english summary */}
            <div style={{ background: T.card, border: `1px solid ${risk.riskColor}33`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
              <div style={{ fontSize: "9px", color: risk.riskColor, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "10px" }}>Combined Risk Summary</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {!risk.betaComingSoon && <div style={{ fontSize: "14px", color: T.text }}>📊 {risk.betaLabel}</div>}
                <div style={{ fontSize: "14px", color: T.text }}>⚠️ {risk.varLabel}</div>
                <div style={{ fontSize: "13px", color: T.sub }}>📉 Estimated max drawdown in a crash: <span style={{ color: T.red, fontWeight: 700 }}>−{(risk.maxDrawdownEst * 100).toFixed(0)}%</span> <span style={{ color: T.muted }}>{isIndia ? "(NIFTY historical proxy)" : "(based on beta vs S&P −34% historical)"}</span></div>
              </div>
            </div>

            {/* Roll-up warnings */}
            {risk.warnings.length > 0 && (
              <div style={{ marginBottom: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>Combined Action Items</div>
                {risk.warnings.map((w, i) => (
                  <div key={i} style={{ background: severityBg(w.severity), border: `1px solid ${severityColor(w.severity)}33`, borderRadius: "10px", padding: "12px 16px" }}>
                    <div style={{ fontSize: "13px", color: severityColor(w.severity), fontWeight: 600, marginBottom: w.action ? "4px" : 0 }}>{w.severity === "critical" ? "🔴" : "🟡"} {w.message}</div>
                    {w.action && <div style={{ fontSize: "12px", color: T.sub }}>→ {w.action}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* Roll-up sector breakdown */}
            {risk.sectorBreakdown.length > 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "24px" }}>
                <SectorSection breakdown={risk.sectorBreakdown} isIndia={isIndia} cur={cur} />
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "12px", borderTop: `1px solid ${T.border}`, paddingTop: "10px" }}>
                  {isIndia
                    ? "Sector weights of combined ₹ India book."
                    : "OW = overweight vs S&P 500 sector weight. Shown across all connected accounts."}
                </div>
              </div>
            )}

            {/* Proposal Impact */}
            {risk.proposalImpact && (
              <div style={{ background: "#1E1F3A", border: `1px solid ${T.accent}44`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
                <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "10px" }}>Pending Proposal Impact</div>
                <div style={{ fontSize: "13px", color: T.sub, marginBottom: "12px" }}>{risk.proposalImpact.description}</div>
                <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: "10px", color: T.muted, marginBottom: "2px" }}>Beta now → after</div>
                    <span style={{ color: betaColor(risk.portfolioBeta ?? 0) }}>{risk.portfolioBeta != null ? risk.portfolioBeta.toFixed(2) : "—"}</span>
                    <span style={{ color: T.muted }}> → </span>
                    <span style={{ color: betaColor(risk.proposalImpact.newBeta ?? 0), fontWeight: 700 }}>{risk.proposalImpact.newBeta != null ? risk.proposalImpact.newBeta.toFixed(2) : "—"}</span>
                  </div>
                  <div>
                    <div style={{ fontSize: "10px", color: T.muted, marginBottom: "2px" }}>Tech % now → after</div>
                    <span style={{ color: T.text }}>{(risk.sectorBreakdown.find(s => s.sector === "Technology")?.weightPct ?? 0) * 100 | 0}%</span>
                    <span style={{ color: T.muted }}> → </span>
                    <span style={{ color: risk.proposalImpact.newTechConcentration > 0.55 ? T.red : T.text, fontWeight: 700 }}>{(risk.proposalImpact.newTechConcentration * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Per-Account Sections ── */}
            {accountRisks.length > 0 && (
              <>
                <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "12px", marginTop: "8px" }}>
                  Per-Account Breakdown
                </div>
                {accountRisks.map(ar => (
                  <AccountRiskSection key={ar.accountId} ar={ar} isIndia={isIndia} />
                ))}
              </>
            )}

            <div style={{ fontSize: "11px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              {isIndia
                ? "India VaR uses NIFTY 50 daily volatility (1.0%) × 1.645 z-score. Beta vs NIFTY from 1y candles when available. Not financial advice."
                : "Beta approximations are sector-based averages. The loss proxy uses portfolio beta × historical SPY daily volatility (0.85%) × 1.645; it is not full covariance VaR. Not financial advice."}
              {" "}Last updated: {new Date(data.fetchedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
