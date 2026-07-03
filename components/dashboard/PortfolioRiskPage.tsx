"use client";
import { useState, useEffect, useCallback } from "react";
import PageHeader from "./PageHeader";
import type { RiskMetrics, HoldingWithRisk, SectorBreakdown } from "@/lib/portfolio-risk";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", orange: "#F97316", red: "#F87171",
  greenBg: "#052E16", amberBg: "#2D1B00", redBg: "#3B0000",
};

type AccountSummary = {
  source: string;
  totalValue: number;
  cashBalance: number;
  holdingCount: number;
  fetchedAt: string;
  error?: string;
};

const SOURCE_LABELS: Record<string, string> = {
  internal: "Paper (Kairos)",
  alpaca_paper: "Alpaca Paper",
  alpaca_live: "Alpaca Live",
  robinhood: "Robinhood",
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

export default function PortfolioRiskPage() {
  const [data, setData]       = useState<{ accounts: AccountSummary[]; risk: RiskMetrics; fetchedAt: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/portfolio/holdings");
      if (!res.ok) throw new Error(await res.text());
      setData(await res.json());
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ padding: "28px", color: T.muted, fontSize: "14px" }}>Fetching holdings from all accounts…</div>;
  if (error)   return <div style={{ padding: "28px", color: T.red, fontSize: "14px" }}>Error: {error}</div>;
  if (!data)   return null;

  const { accounts, risk } = data;

  return (
    <div>
      <PageHeader
        title="Portfolio Risk"
        subtitle="Live risk analytics across all connected accounts"
        cadence="as-needed"
        whatItDoes="Aggregates real holdings from all connected brokers (Alpaca, Robinhood) and your paper portfolio. Computes concentration risk, market sensitivity (beta), potential daily loss (VaR), and sector exposure vs the S&P 500."
        whatToLookFor={[
          "Risk score above 75 means you're carrying more risk than most retail portfolios.",
          "Sector overweight above 2× vs S&P 500 means a sector crash hits you much harder.",
          "Correlated pairs mean less diversification — holding NVDA + AMD is less safe than it looks.",
          "Proposal Impact shows how pending agent trades would change your risk profile before you approve.",
        ]}
      />

      <div style={{ padding: "0 28px 40px" }}>

        {/* Refresh */}
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "16px" }}>
          <button onClick={load} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.sub, padding: "7px 16px", fontSize: "12px", cursor: "pointer" }}>
            ↻ Refresh
          </button>
        </div>

        {/* Account pills */}
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>
          {accounts.map(a => (
            <div key={a.source} style={{ background: a.error ? T.redBg : T.card, border: `1px solid ${a.error ? T.red + "44" : T.border}`, borderRadius: "8px", padding: "8px 14px", fontSize: "12px" }}>
              <span style={{ color: T.sub }}>{SOURCE_LABELS[a.source] ?? a.source}</span>
              {a.error
                ? <span style={{ color: T.red, marginLeft: "8px" }}>— {a.error.slice(0, 60)}</span>
                : <span style={{ color: T.text, fontWeight: 700, marginLeft: "8px" }}>${a.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
              }
              {!a.error && <span style={{ color: T.muted, marginLeft: "6px" }}>· {a.holdingCount} positions</span>}
            </div>
          ))}
        </div>

        {risk.holdingCount === 0 ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center", color: T.muted }}>
            No holdings found. Connect Alpaca (add keys in Admin → Vault) or open paper positions.
          </div>
        ) : (
          <>

            {/* ── At a glance ── */}
            <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "20px" }}>
              <StatCard label="Total Value" value={`$${risk.totalValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} sub={`${risk.holdingCount} positions`} />
              <StatCard
                label="Risk Score"
                value={`${risk.riskScore}/100`}
                sub={risk.riskLabel}
                color={risk.riskColor}
              />
              <StatCard
                label="Market Sensitivity"
                value={`β ${risk.portfolioBeta.toFixed(2)}`}
                sub={risk.portfolioBeta > 1 ? `${Math.round((risk.portfolioBeta - 1) * 100)}% more volatile than market` : `${Math.round((1 - risk.portfolioBeta) * 100)}% less volatile than market`}
                color={betaColor(risk.portfolioBeta)}
              />
              <StatCard
                label="1-Day VaR (95%)"
                value={`−$${risk.var95_dollar.toFixed(0)}`}
                sub={`${(risk.var95_pct * 100).toFixed(1)}% · bad-day loss estimate`}
                color={T.amber}
              />
            </div>

            {/* ── Plain-English Risk Summary ── */}
            <div style={{ background: T.card, border: `1px solid ${risk.riskColor}33`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
              <div style={{ fontSize: "9px", color: risk.riskColor, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "10px" }}>Risk Summary</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ fontSize: "14px", color: T.text }}>📊 {risk.betaLabel}</div>
                <div style={{ fontSize: "14px", color: T.text }}>⚠️ {risk.varLabel}</div>
                <div style={{ fontSize: "13px", color: T.sub }}>📉 Estimated max drawdown in a market crash: <span style={{ color: T.red, fontWeight: 700 }}>−{(risk.maxDrawdownEst * 100).toFixed(0)}%</span> <span style={{ color: T.muted }}>(based on portfolio beta vs S&P historical −34%)</span></div>
              </div>
            </div>

            {/* ── Warnings ── */}
            {risk.warnings.length > 0 && (
              <div style={{ marginBottom: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
                <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>Action Items</div>
                {risk.warnings.map((w, i) => (
                  <div key={i} style={{ background: severityBg(w.severity), border: `1px solid ${severityColor(w.severity)}33`, borderRadius: "10px", padding: "12px 16px" }}>
                    <div style={{ fontSize: "13px", color: severityColor(w.severity), fontWeight: 600, marginBottom: w.action ? "4px" : 0 }}>{w.severity === "critical" ? "🔴" : "🟡"} {w.message}</div>
                    {w.action && <div style={{ fontSize: "12px", color: T.sub }}>→ {w.action}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* ── Holdings table ── */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
              <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "14px" }}>Holdings Breakdown</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ color: T.muted, borderBottom: `1px solid ${T.border}` }}>
                      {["Symbol", "Sector", "Value", "Weight", "Beta", "P&L", "Source"].map(h => (
                        <th key={h} style={{ padding: "6px 10px", textAlign: "left", fontWeight: 600 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {risk.holdings.map((h, i) => {
                      const pnlColor = (h.unrealizedPnl ?? 0) >= 0 ? T.green : T.red;
                      const weightColor = h.weightPct > 0.20 ? T.red : h.weightPct > 0.15 ? T.amber : T.text;
                      return (
                        <tr key={`${h.symbol}-${h.source}-${i}`} style={{ borderBottom: `1px solid ${T.border}44` }}>
                          <td style={{ padding: "8px 10px", fontWeight: 700, color: T.text }}>{h.symbol}</td>
                          <td style={{ padding: "8px 10px", color: T.sub }}>{h.sector}</td>
                          <td style={{ padding: "8px 10px", color: T.text }}>${h.marketValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                          <td style={{ padding: "8px 10px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                              <span style={{ color: weightColor, fontWeight: 600, width: "36px" }}>{(h.weightPct * 100).toFixed(1)}%</span>
                              <Bar pct={h.weightPct} color={weightColor} maxPct={0.25} />
                            </div>
                          </td>
                          <td style={{ padding: "8px 10px", color: betaColor(h.beta) }}>{h.beta.toFixed(2)}</td>
                          <td style={{ padding: "8px 10px", color: pnlColor }}>
                            {h.unrealizedPnl != null ? (
                              <>
                                {(h.unrealizedPnl ?? 0) >= 0 ? "+" : ""}{(h.unrealizedPnlPct ?? 0) >= 0 ? "+" : ""}{((h.unrealizedPnlPct ?? 0) * 100).toFixed(1)}%
                              </>
                            ) : "—"}
                          </td>
                          <td style={{ padding: "8px 10px", color: T.muted, fontSize: "10px" }}>{SOURCE_LABELS[h.source] ?? h.source}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ── Sector breakdown ── */}
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
              <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "14px" }}>Sector Exposure vs S&P 500</div>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                {risk.sectorBreakdown.map(s => {
                  const overColor = s.overweightPct > 0.15 ? T.red : s.overweightPct > 0.05 ? T.amber : T.green;
                  return (
                    <div key={s.sector}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5px", fontSize: "12px" }}>
                        <span style={{ color: T.text, fontWeight: 600 }}>{s.sector}</span>
                        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                          <span style={{ color: overColor, fontWeight: 700 }}>{(s.weightPct * 100).toFixed(0)}%</span>
                          <span style={{ color: T.muted }}>S&P: {(s.sp500WeightPct * 100).toFixed(0)}%</span>
                          {s.overweightPct > 0.03 && (
                            <span style={{ color: overColor, fontSize: "10px", background: overColor + "22", padding: "2px 7px", borderRadius: "4px" }}>
                              +{(s.overweightPct * 100).toFixed(0)}% OW
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        <Bar pct={s.weightPct} color={overColor} maxPct={0.70} />
                        {/* S&P marker */}
                        <div style={{ fontSize: "10px", color: T.muted, width: "28px", textAlign: "right" }}>{s.holdingCount}×</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "14px", borderTop: `1px solid ${T.border}`, paddingTop: "10px" }}>
                OW = overweight vs S&P 500 sector weight. High overweight = concentrated sector risk.
              </div>
            </div>

            {/* ── Correlated pairs ── */}
            {risk.correlatedPairs.length > 0 && (
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px", marginBottom: "20px" }}>
                <div style={{ fontSize: "9px", color: T.accent, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: "12px" }}>Correlated Pairs</div>
                <div style={{ fontSize: "12px", color: T.sub, marginBottom: "12px" }}>High correlation means holding both positions gives you less diversification than it appears.</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  {risk.correlatedPairs.map(p => {
                    const c = p.severity === "high" ? T.red : T.amber;
                    return (
                      <div key={`${p.symbol1}:${p.symbol2}`} style={{ display: "flex", alignItems: "center", gap: "12px", padding: "10px 14px", background: p.severity === "high" ? T.redBg : T.amberBg, border: `1px solid ${c}33`, borderRadius: "8px" }}>
                        <span style={{ fontWeight: 700, color: T.text }}>{p.symbol1}</span>
                        <span style={{ color: T.muted }}>+</span>
                        <span style={{ fontWeight: 700, color: T.text }}>{p.symbol2}</span>
                        <span style={{ marginLeft: "auto", color: c, fontWeight: 700 }}>{(p.correlation * 100).toFixed(0)}% correlated</span>
                        <span style={{ fontSize: "10px", color: T.muted }}>{p.severity === "high" ? "🔴 High" : "🟡 Medium"}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── Proposal Impact ── */}
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
                    <div style={{ fontSize: "10px", color: T.muted, marginBottom: "2px" }}>Tech exposure now → after</div>
                    <span style={{ color: T.text }}>{(risk.sectorBreakdown.find(s => s.sector === "Technology")?.weightPct ?? 0) * 100 | 0}%</span>
                    <span style={{ color: T.muted }}> → </span>
                    <span style={{ color: risk.proposalImpact.newTechConcentration > 0.55 ? T.red : T.text, fontWeight: 700 }}>{(risk.proposalImpact.newTechConcentration * 100).toFixed(0)}%</span>
                  </div>
                  <div>
                    <div style={{ fontSize: "10px", color: T.muted, marginBottom: "2px" }}>Max position now → after</div>
                    <span style={{ color: T.text }}>{(Math.max(...risk.holdings.map(h => h.weightPct)) * 100).toFixed(0)}%</span>
                    <span style={{ color: T.muted }}> → </span>
                    <span style={{ color: risk.proposalImpact.newMaxConcentration > 0.20 ? T.red : T.text, fontWeight: 700 }}>{(risk.proposalImpact.newMaxConcentration * 100).toFixed(0)}%</span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ fontSize: "11px", color: T.muted, borderTop: `1px solid ${T.border}`, paddingTop: "14px" }}>
              Beta approximations are sector-based averages. VaR uses portfolio beta × historical SPY daily volatility (0.85%) × 1.645 z-score. Not financial advice.
              Last updated: {new Date(data.fetchedAt).toLocaleTimeString()}
            </div>

          </>
        )}
      </div>
    </div>
  );
}
