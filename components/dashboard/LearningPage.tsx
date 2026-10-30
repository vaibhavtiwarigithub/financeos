"use client";
import { useEffect, useRef, useState } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import PerformanceTruth from "@/components/dashboard/PerformanceTruth";
import StrategyGovernancePanel from "@/components/dashboard/StrategyGovernancePanel";
import StrategyTemplateLabPanel from "@/components/dashboard/StrategyTemplateLabPanel";
import DimensionDiagnosticsSummary from "@/components/dashboard/DimensionDiagnosticsSummary";
import DimensionIcPanel from "@/components/dashboard/DimensionIcPanel";
import IcRegressionPanel from "@/components/dashboard/IcRegressionPanel";
import CouncilIcPanel from "@/components/dashboard/CouncilIcPanel";
import PredictionLabPanel from "@/components/dashboard/PredictionLabPanel";
import EventIcPanel from "@/components/dashboard/EventIcPanel";
import IndexSleevePanel from "@/components/dashboard/IndexSleevePanel";
import ScoreVariantsPanel from "@/components/dashboard/ScoreVariantsPanel";
import ScoreFormulaMiningPanel from "@/components/dashboard/ScoreFormulaMiningPanel";
import MacroContextPanel from "@/components/dashboard/MacroContextPanel";
import { fmtMoney, type Mkt } from "@/lib/format-money";
import { navReturnPct, paperStartNav } from "@/lib/paper-nav";
import {
  ResponsiveContainer, LineChart as LC, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine,
} from "recharts";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000",
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "32px 0" }}>{msg}</div>;
}

/** Keep existing panels mounted so opening a section never resets its filters. */
function LearningSection({ id, title, description, children }: { id: string; title: string; description: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const revealTarget = (hash: string) => {
      const target = document.getElementById(hash.slice(1));
      if (target && ref.current?.contains(target)) {
        ref.current.open = true;
        requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
      }
    };
    const reveal = () => revealTarget(window.location.hash);
    // Clicking the current fragment does not emit hashchange. Open before the
    // browser follows the anchor so manually closed groups still reveal.
    const followFragment = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
      if (anchor?.hash) revealTarget(anchor.hash);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    document.addEventListener("click", followFragment);
    return () => {
      window.removeEventListener("hashchange", reveal);
      document.removeEventListener("click", followFragment);
    };
  }, []);
  return <details ref={ref} id={id} data-learning-section style={{ marginBottom: 16, border: `1px solid ${T.border}`, borderRadius: 12, background: T.surface, scrollMarginTop: 24 }}>
    <summary style={{ cursor: "pointer", padding: "18px 20px", color: T.text }}>
      <h2 style={{ display: "inline", fontSize: 15, margin: 0 }}>{title}</h2>
      <span style={{ display: "block", color: T.textSub, fontSize: 12, lineHeight: 1.6, marginTop: 6 }}>{description}</span>
    </summary>
    <div style={{ padding: "0 clamp(8px, 2vw, 20px) 18px", minWidth: 0, overflowX: "auto" }}>{children}</div>
  </details>;
}

function CustomTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
      <div style={{ color: T.muted, marginBottom: "4px" }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>{p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}</div>
      ))}
    </div>
  );
}

interface WeightRow {
  signal_adjusted: string;
  old_weight: number;
  new_weight: number;
  reason: string;
  accuracy_before: number | null;
  accuracy_after: number | null;
  created_at: string;
}

interface LearningLogRow {
  id?: string;
  note: string;
  trades_evaluated: number | null;
  weight_snapshot: any;
  created_at: string;
}

interface PerfRow {
  date: string;
  nav: number;
  win_rate: number | null;
}

interface WeightConfig {
  fundamental_weight: number;
  technical_weight: number;
  sentiment_weight: number;
  macro_weight: number;
  insider_weight: number;
  updated_at: string | null;
}

export default function LearningPage({
  learningLog,
  fullLog,
  performance,
  weights,
  totalTrades,
  winRate,
  market,
  showHeader = true,
}: {
  learningLog: WeightRow[];
  fullLog: LearningLogRow[];
  performance: PerfRow[];
  weights: WeightConfig | null;
  totalTrades: number;
  winRate: number;
  /** Book being displayed. `performance`/`totalTrades`/`winRate` are already
   *  scoped to it upstream — used here for the NAV seed and currency. */
  market: Mkt;
  showHeader?: boolean;
}) {
  const [tab, setTab] = useState<"accuracy" | "weights" | "equity">("accuracy");

  const weightBars = weights ? [
    { signal: "Fundamental", value: +(weights.fundamental_weight * 100).toFixed(1) },
    { signal: "Technical",   value: +(weights.technical_weight   * 100).toFixed(1) },
    { signal: "Sentiment",   value: +(weights.sentiment_weight   * 100).toFixed(1) },
    { signal: "Macro",       value: +(weights.macro_weight       * 100).toFixed(1) },
    { signal: "Insider",     value: +(weights.insider_weight     * 100).toFixed(1) },
  ] : [];

  // Return % is measured against THIS market's own paper seed ($10k / ₹10L).
  const equityCurve = performance.map(p => ({
    date: p.date.slice(5),
    nav: fmtMoney(p.nav, market),
    return: navReturnPct(p.nav, market),
  }));

  const accData = performance
    .filter(p => p.win_rate !== null)
    .map(p => ({ date: p.date.slice(5), winRate: +(p.win_rate! * 100).toFixed(1) }));

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      {showHeader && (
        <PageHeader
          title="Learning"
          subtitle="Prediction quality, experiments and learning history"
          cadence="weekly"
          whatItDoes="Compare scores with later returns, inspect data coverage and follow research experiments. Prediction evidence is separate from portfolio impact and approval to trade."
          whatToLookFor={[
            "Start with Prediction Lab, then open the evidence section for your question.",
            "IC measures ranking against later returns; it is not win probability or portfolio profit.",
            "Insufficient evidence can mean outcomes have not matured, not that a collector failed.",
            "Trade counts alone do not approve a formula, weight change or live trading.",
          ]}
        />
      )}
      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) 32px" }}>

      <nav aria-label="Learning sections" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
        {[["prediction-lab", "Start here"], ["dimension-evidence", "Dimension health"], ["council-evidence", "LLM council"], ["formula-evidence", "Formula experiments"], ["strategy-evidence", "Strategies"], ["market-evidence", "Market context"], ["learning-history", "Learning history"]].map(([id, label]) => <a key={id} href={`#${id}`} style={{ color: T.textSub, fontSize: 12, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 6 }}>{label}</a>)}
      </nav>
      <p style={{ color: T.textSub, fontSize: 12, lineHeight: 1.6, margin: "0 0 20px" }}>Choose a question below. IC = Information Coefficient (score ranking versus later return). t-statistic describes signal relative to estimated noise; its limits are shown with each method. Research evidence is not permission to trade. <a href="/dashboard/upgrade-path" style={{ color: T.accent }}>Collection health & portfolio-impact gates → Upgrade Path</a></p>
      <PredictionLabPanel />
      <LearningSection id="dimension-evidence" title="Dimension health & regressions" description="Are our deterministic scores predictive, and is the underlying evidence complete?">
        <DimensionDiagnosticsSummary /><DimensionIcPanel /><IcRegressionPanel />
      </LearningSection>
      <LearningSection id="council-evidence" title="LLM council · scores & coverage" description="Inspect each model, consensus, matured labels and missing forecasts. This is not a trading score.">
        <CouncilIcPanel />
      </LearningSection>
      <LearningSection id="formula-evidence" title="Formula experiments & historical fits" description="Compare recorded variants and exploratory fits. Historical fit is not evidence of future profit.">
        <ScoreVariantsPanel /><ScoreFormulaMiningPanel />
        {market === "us" && <ScoreVariantsPanel set="insider_v2" />}
      </LearningSection>
      <LearningSection id="strategy-evidence" title="Strategy governance" description="Review strategy lifecycle, validation and promotion gates; no automatic adoption from this page.">
        <StrategyTemplateLabPanel /><StrategyGovernancePanel />
      </LearningSection>
      <LearningSection id="market-evidence" title="Market context & event studies" description="Separate macro conditions, earnings-event evidence and index-sleeve comparisons from stock-score tests.">
        <MacroContextPanel market={market} /><EventIcPanel /><IndexSleevePanel />
      </LearningSection>
      <LearningSection id="learning-history" title="Portfolio outcomes & learning history" description="Selected-market paper outcomes and current weights, followed by the global LearnerAgent log. Win rate is not prediction IC.">

      <p style={{ color: T.textSub, fontSize: 12, lineHeight: 1.6 }}>Research produces instrument-aware scores; the portfolio engine applies eligibility, cash and risk constraints. Realized outcomes feed the learning log. Neither a high score nor a trade count automatically approves a weight change. Current champion weights are shown in Signal Weights; each historical observation retains its own formula and availability mask.</p>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        {[
          { label: "Total Trades", value: String(totalTrades), sub: "paper closed" },
          { label: "Win Rate", value: totalTrades > 0 ? winRate.toFixed(1) + "%" : "—", sub: "closed paper outcomes", color: winRate >= 60 ? T.green : totalTrades > 0 ? T.amber : T.muted },
          { label: "Weight History", value: learningLog.length ? String(learningLog.length) : "—", sub: "loaded change records; not lifetime count" },
          { label: "Last Update", value: weights?.updated_at ? new Date(weights.updated_at).toLocaleDateString() : "—", sub: "signal weights" },
        ].map(s => (
          <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px" }}>
            <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{s.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: s.color ?? T.text }}>{s.value}</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Performance Truth — risk-adjusted / cost-net / calibrated metrics */}
      {showHeader && <PerformanceTruth />}

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", marginTop: "24px", overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch" }}>
        {(["accuracy", "weights", "equity"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize", flexShrink: 0, whiteSpace: "nowrap" }}>
            {t === "accuracy" ? "Accuracy Trend" : t === "weights" ? "Signal Weights" : "Equity Curve"}
          </button>
        ))}
      </div>

      {/* Accuracy trend */}
      {tab === "accuracy" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: "16px" }}>
          <Card title="Win Rate Over Time">
            {accData.length === 0
              ? <Empty msg="No stored closed-trade win-rate series for this market yet." />
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <LC data={accData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} />
                    <Tooltip content={<CustomTip />} />
                    <ReferenceLine y={60} stroke={T.accent} strokeDasharray="4 4" label={{ value: "60% target", fill: T.accent, fontSize: 10, position: "right" }} />
                    <Line type="monotone" dataKey="winRate" name="Win %" stroke={T.green} strokeWidth={2} dot={false} />
                  </LC>
                </ResponsiveContainer>
              )}
          </Card>

          <Card title="Weight Change Log">
            {learningLog.length === 0
              ? <Empty msg="No weight-change records loaded in this view. This does not establish that weights have never changed." />
              : (
                <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                  {learningLog.map((row, i) => (
                    <div key={i} style={{ borderBottom: `1px solid ${T.border}`, padding: "10px 0", fontSize: "12px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                        <span style={{ fontWeight: 600, color: T.text }}>{row.signal_adjusted}</span>
                        <span style={{ color: T.muted }}>{new Date(row.created_at).toLocaleDateString()}</span>
                      </div>
                      <div style={{ color: T.textSub }}>
                        {(row.old_weight * 100).toFixed(1)}% → {" "}
                        <span style={{ color: row.new_weight > row.old_weight ? T.green : T.red, fontWeight: 700 }}>
                          {(row.new_weight * 100).toFixed(1)}%
                        </span>
                      </div>
                      {row.reason && <div style={{ color: T.muted, marginTop: "3px", fontSize: "11px" }}>{row.reason}</div>}
                    </div>
                  ))}
                </div>
              )}
          </Card>
        </div>
      )}

      {/* Signal weights */}
      {tab === "weights" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: "16px" }}>
          <Card title="Current Signal Weights">
            {weightBars.length === 0
              ? <Empty msg="No weights configured" />
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={weightBars} layout="vertical" margin={{ top: 0, right: 30, left: 60, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 40]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} unit="%" />
                    <YAxis type="category" dataKey="signal" tick={{ fontSize: 11, fill: T.textSub }} tickLine={false} axisLine={false} width={80} />
                    <Tooltip content={<CustomTip />} />
                    <Bar dataKey="value" name="Weight" radius={[0, 4, 4, 0]}>
                      {weightBars.map((_, i) => (
                        <Cell key={i} fill={[T.accent, T.green, T.amber, "#60A5FA", "#A78BFA"][i % 5]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
          </Card>

          <Card title="Weight Evolution">
            {learningLog.length < 2
              ? <Empty msg="Need 2+ weight changes to show evolution" />
              : (() => {
                const signals = [...new Set(learningLog.map(r => r.signal_adjusted))];
                const byDate = learningLog.reduce((acc: any, row) => {
                  const d = row.created_at.slice(0, 10);
                  if (!acc[d]) acc[d] = { date: d.slice(5) };
                  acc[d][row.signal_adjusted] = +(row.new_weight * 100).toFixed(1);
                  return acc;
                }, {});
                const data = Object.values(byDate) as any[];
                const colors = [T.accent, T.green, T.amber, "#60A5FA", "#A78BFA"];
                return (
                  <ResponsiveContainer width="100%" height={220}>
                    <LC data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                      <YAxis domain={[0, 40]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} unit="%" />
                      <Tooltip content={<CustomTip />} />
                      {signals.map((s, i) => (
                        <Line key={s} type="monotone" dataKey={s} name={s} stroke={colors[i % 5]} strokeWidth={2} dot={false} />
                      ))}
                    </LC>
                  </ResponsiveContainer>
                );
              })()}
          </Card>
        </div>
      )}

      {/* Equity curve */}
      {tab === "equity" && (
        <Card title={`Paper Portfolio Equity Curve · ${market === "india" ? "India" : "US"} book vs ${fmtMoney(paperStartNav(market), market, 0)} seed`}>
          {equityCurve.length === 0
            ? <Empty msg={`No ${market === "india" ? "India" : "US"} paper performance yet — the curve builds after this book's first paper trades.`} />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <LC data={equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={40} unit="%" />
                  <Tooltip content={<CustomTip />} />
                  <ReferenceLine y={0} stroke={T.muted} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="return" name="Return %" stroke={T.green} strokeWidth={2} dot={false} />
                </LC>
              </ResponsiveContainer>
            )}
        </Card>
      )}

      {/* Full Learning Log */}
      <div style={{ marginTop: "24px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontSize: "11px", color: T.textSub, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Learning Log · global, both markets</div>
        {fullLog.length === 0 ? (
          <Empty msg="No learning notes loaded. Review agent run health before inferring that no learning occurred." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {fullLog.map((entry, i) => {
              const d = new Date(entry.created_at);
              const dateStr = d.toLocaleDateString("en-US", { weekday: "short", year: "numeric", month: "short", day: "numeric" });
              const timeStr = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
              return (
                <div key={i} style={{ borderBottom: i < fullLog.length - 1 ? `1px solid ${T.border}` : "none", paddingBottom: i < fullLog.length - 1 ? "12px" : "0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px", gap: "16px" }}>
                    <div style={{ fontSize: "11px", color: T.muted }}>{dateStr} · {timeStr}</div>
                    {entry.trades_evaluated != null && entry.trades_evaluated > 0 && (
                      <div style={{ fontSize: "11px", color: T.accent, background: "#1E1B4B", borderRadius: "4px", padding: "2px 8px", flexShrink: 0 }}>
                        {entry.trades_evaluated} trade{entry.trades_evaluated !== 1 ? "s" : ""} evaluated
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.6", wordBreak: "break-word" }}>{entry.note}</div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </LearningSection>
      </div>
    </div>
  );
}
