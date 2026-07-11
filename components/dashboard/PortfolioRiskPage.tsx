"use client";
import { useState, useEffect, useCallback } from "react";
import PageHeader from "./PageHeader";
import { useMarket } from "@/lib/market-context";
import type { RiskMetrics, HoldingWithRisk, SectorBreakdown } from "@/lib/portfolio-risk";

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
                <td style={{ padding: "8px 10px", color: T.text }}>{cur}{h.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                <td style={{ padding: "8px 10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{ color: weightColor, fontWeight: 600, width: "36px" }}>{(h.weightPct * 100).toFixed(1)}%</span>
                    <Bar pct={h.weightPct} color={weightColor} maxPct={0.25} />
                  </div>
                </td>
                <td style={{ padding: "8px 10px", color: risk.betaComingSoon ? T.muted : betaColor(h.beta) }}>
                  {risk.betaComingSoon ? "—" : h.beta.toFixed(2)}
                </td>
                <td style={{ padding: "8px 10px", color: pnlColor }}>
                  {h.unrealizedPnl != null
                    ? `${(h.unrealizedPnl ?? 0) >= 0 ? "+" : ""}${cur}${Math.abs(h.unrealizedPnl ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} (${(h.unrealizedPnlPct ?? 0) >= 0 ? "+" : ""}${((h.unrealizedPnlPct ?? 0)).toFixed(1)}%)`
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
      <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "10px" }}>
        {isIndia ? "Sector Exposure" : "Sector Exposure vs S&P 500"}
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
                {cur}{ar.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })} equity
                · {risk.holdingCount} positions
                · {cur}{ar.cashBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} cash
              </div>
            )}
        </div>
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          {!ar.error && (
            <>
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
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>VaR</div>
                <div style={{ fontSize: "14px", fontWeight: 700, color: T.amber }}>−{cur}{risk.var95_dollar.toFixed(0)}</div>
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
        whatItDoes="Fetches live positions from Robinhood (US) or Kite (India) via REST API. Computes per-account and combined concentration risk, market sensitivity (beta), potential daily loss (VaR), and sector exposure."
        whatToLookFor={[
          "Risk score above 75 means you're carrying more risk than most retail portfolios.",
          "Sector overweight above 2× vs S&P 500 means a sector crash hits you much harder.",
          "Correlated pairs mean less diversification — holding NVDA + AMD is less safe than it looks.",
          "Per-account sections below show independent risk for each brokerage account.",
        ]}
      />

      <div style={{ padding: "0 clamp(12px, 4vw, 28px) clamp(20px, 5vw, 40px)" }}>

        {/* Refresh */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
          <button onClick={load} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.sub, padding: "7px 16px", fontSize: "12px", cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

        {/* Account pills */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
          {accounts.map((a, i) => (
            <div key={`${a.source}-${a.accountId ?? i}`} style={{ background: a.error ? T.redBg : T.card, border: `1px solid ${a.error ? T.red + "44" : T.border}`, borderRadius: "8px", padding: "8px 14px", fontSize: "12px" }}>
              <span style={{ color: T.sub }}>{a.accountLabel ?? a.source}</span>
              {a.error
                ? <span style={{ color: T.red, marginLeft: "8px" }}>— {a.error.slice(0, 60)}</span>
                : (
                  <>
                    <span style={{ color: T.text, fontWeight: 700, marginLeft: "8px" }}>{cur}{a.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
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
              : "No Robinhood holdings found. Ensure the Robinhood OAuth token is active in Admin → Vault."}
          </div>
        ) : (
          <>
            {/* ── Roll-up: at a glance ── */}
            <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "12px" }}>
              Combined Across All Accounts
            </div>
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "20px" }}>
              <StatCard label="Total Value" value={`${cur}${risk.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} sub={`${risk.holdingCount} positions`} />
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
                label="1-Day VaR (95%)"
                value={`−${cur}${risk.var95_dollar.toFixed(0)}`}
                sub={`${(risk.var95_pct * 100).toFixed(1)}% · bad-day loss estimate`}
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
                    <span style={{ color: betaColor(risk.portfolioBeta) }}>{risk.portfolioBeta.toFixed(2)}</span>
                    <span style={{ color: T.muted }}> → </span>
                    <span style={{ color: betaColor(risk.proposalImpact.newBeta), fontWeight: 700 }}>{risk.proposalImpact.newBeta.toFixed(2)}</span>
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
                : "Beta approximations are sector-based averages. VaR uses portfolio beta × historical SPY daily volatility (0.85%) × 1.645 z-score. Not financial advice."}
              {" "}Last updated: {new Date(data.fetchedAt).toLocaleTimeString()}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
