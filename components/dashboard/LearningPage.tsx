"use client";
import { useState } from "react";
import { lazy, Suspense } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
const LineChart = lazy(() => import("recharts").then(m => ({ default: m.LineChart })));
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
  total_trades: number;
}

interface WeightConfig {
  fundamental_weight: number;
  technical_weight: number;
  sentiment_weight: number;
  macro_weight: number;
  insider_weight: number;
  updated_at: string;
}

export default function LearningPage({
  learningLog,
  fullLog,
  performance,
  weights,
  totalTrades,
  winRate,
}: {
  learningLog: WeightRow[];
  fullLog: LearningLogRow[];
  performance: PerfRow[];
  weights: WeightConfig | null;
  totalTrades: number;
  winRate: number;
}) {
  const [tab, setTab] = useState<"accuracy" | "weights" | "equity">("accuracy");

  const weightBars = weights ? [
    { signal: "Fundamental", value: +(weights.fundamental_weight * 100).toFixed(1) },
    { signal: "Technical",   value: +(weights.technical_weight   * 100).toFixed(1) },
    { signal: "Sentiment",   value: +(weights.sentiment_weight   * 100).toFixed(1) },
    { signal: "Macro",       value: +(weights.macro_weight       * 100).toFixed(1) },
    { signal: "Insider",     value: +(weights.insider_weight     * 100).toFixed(1) },
  ] : [];

  const equityCurve = performance.map(p => ({
    date: p.date.slice(5),
    nav: p.nav,
    return: +(((p.nav - 10000) / 10000) * 100).toFixed(2),
  }));

  const accData = performance
    .filter(p => p.win_rate !== null)
    .map(p => ({ date: p.date.slice(5), winRate: +(p.win_rate! * 100).toFixed(1) }));

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <PageHeader
        title="Learning"
        subtitle="Agent intelligence and weight evolution"
        cadence="weekly"
        whatItDoes="Shows the LearnerAgent's memory — what it learned from closed trades, how the scoring weights evolve over time, and whether Phase 1 (live weight mutation) is unlocked yet."
        whatToLookFor={[
          "Phase 0 = learning but weights frozen. Need 10+ closed paper trades to unlock Phase 1.",
          "Weight bars show how the agent weighs momentum vs value vs fundamentals.",
          "Learning notes are 1-sentence summaries the agent writes after each closed trade.",
          "If no notes appear, no trades have closed yet — check the Trading page.",
        ]}
      />
      <div style={{ padding: "clamp(12px, 4vw, 28px) clamp(12px, 4vw, 28px) 32px" }}>

      {/* Agent Pipeline Diagram */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Agent Pipeline</div>
        <svg viewBox="0 0 700 160" width="100%" style={{ display: "block", maxWidth: "700px" }} xmlns="http://www.w3.org/2000/svg">
          {/* ── Data source: Holdings ── */}
          <rect x="8" y="60" width="90" height="44" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="53" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">Holdings</text>
          <text x="53" y="91" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">(read-only)</text>

          {/* Arrow: Holdings → ResearchAgent */}
          <line x1="98" y1="82" x2="126" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />

          {/* ── Agent: ResearchAgent ── */}
          <rect x="126" y="56" width="108" height="52" rx="8" fill="#6366F1" />
          <text x="180" y="74" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">ResearchAgent</text>
          <text x="180" y="87" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">9 AM weekdays</text>
          <text x="180" y="99" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">FinancialDatasets + AlphaVantage</text>

          {/* Arrow: ResearchAgent → agent_signals */}
          <line x1="234" y1="82" x2="262" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />

          {/* ── Table: agent_signals ── */}
          <rect x="262" y="62" width="90" height="40" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="307" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">agent_signals</text>
          <text x="307" y="92" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">3 per day</text>

          {/* Arrow: agent_signals → PaperTrader with label */}
          <line x1="352" y1="82" x2="382" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />
          <text x="367" y="75" textAnchor="middle" fill="#34D399" fontSize="8" fontFamily="Inter,sans-serif">score ≥ 60</text>

          {/* ── Agent: PaperTrader ── */}
          <rect x="382" y="58" width="96" height="48" rx="8" fill="#6366F1" />
          <text x="430" y="79" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">PaperTrader</text>
          <text x="430" y="93" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">approval_required</text>

          {/* Arrow: PaperTrader → paper_trades */}
          <line x1="478" y1="82" x2="506" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />

          {/* ── Table: paper_trades ── */}
          <rect x="506" y="62" width="84" height="40" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="548" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">paper_trades</text>
          <text x="548" y="92" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">7-day horizon</text>

          {/* Arrow: paper_trades → LearnerAgent */}
          <line x1="590" y1="82" x2="612" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />

          {/* ── Agent: LearnerAgent ── */}
          <rect x="612" y="58" width="82" height="48" rx="8" fill="#6366F1" />
          <text x="653" y="79" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">LearnerAgent</text>
          <text x="653" y="93" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">Sunday 8 PM</text>

          {/* Arrow: LearnerAgent → learning_log (below) */}
          <line x1="653" y1="106" x2="653" y2="124" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />
          <rect x="614" y="124" width="78" height="28" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="653" y="141" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">learning_log</text>

          {/* Screener data source (below ResearchAgent) */}
          <rect x="104" y="120" width="110" height="32" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="159" y="133" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">Screener</text>
          <text x="159" y="145" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">3 candidates / day</text>
          {/* Arrow: Screener → ResearchAgent (upward) */}
          <line x1="159" y1="120" x2="180" y2="108" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr)" />

          {/* Arrowhead marker */}
          <defs>
            <marker id="arr" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#4B5563" />
            </marker>
          </defs>
        </svg>
      </div>

      {/* How analyst_score works */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>How analyst_score works</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "16px" }}>
          {/* Stocks */}
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: T.accent, marginBottom: "8px", letterSpacing: "0.05em" }}>STOCKS</div>
            {[
              "PE ratio vs sector median",
              "Revenue growth acceleration",
              "Free cash flow yield",
              "RSI (momentum signal)",
              "Price vs 50-day EMA",
              "News sentiment score",
              "Insider buying activity",
              "Earnings revision direction",
            ].map(item => (
              <div key={item} style={{ fontSize: "12px", color: T.textSub, marginBottom: "4px", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                <span style={{ color: T.accent, marginTop: "2px", flexShrink: 0 }}>·</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
          {/* ETFs */}
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: T.green, marginBottom: "8px", letterSpacing: "0.05em" }}>ETFs</div>
            {[
              "Macro / sector momentum",
              "RSI (overbought / oversold)",
              "Price vs 50-day EMA",
              "No PE / FCF — ETFs lack fundamentals",
            ].map(item => (
              <div key={item} style={{ fontSize: "12px", color: T.textSub, marginBottom: "4px", display: "flex", alignItems: "flex-start", gap: "6px" }}>
                <span style={{ color: T.green, marginTop: "2px", flexShrink: 0 }}>·</span>
                <span>{item}</span>
              </div>
            ))}
          </div>
          {/* Thresholds */}
          <div>
            <div style={{ fontSize: "11px", fontWeight: 600, color: T.amber, marginBottom: "8px", letterSpacing: "0.05em" }}>THRESHOLDS</div>
            {[
              { range: "0 – 59", label: "No action", color: T.muted },
              { range: "60 – 69", label: "Paper trade", color: T.amber },
              { range: "70+", label: "High conviction", color: T.green },
            ].map(({ range, label, color }) => (
              <div key={range} style={{ fontSize: "12px", marginBottom: "8px", display: "flex", justifyContent: "space-between", alignItems: "center", background: T.surface, borderRadius: "6px", padding: "6px 10px" }}>
                <span style={{ color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{range}</span>
                <span style={{ color, fontWeight: 600 }}>{label}</span>
              </div>
            ))}
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "8px" }}>
              Score is 0–100. Weights adjusted weekly by LearnerAgent after 10+ closed trades.
            </div>
          </div>
        </div>
      </div>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "16px", marginBottom: "24px" }}>
        {[
          { label: "Total Trades", value: String(totalTrades), sub: "paper closed" },
          { label: "Win Rate", value: winRate > 0 ? winRate.toFixed(1) + "%" : "—", sub: "target: 60%", color: winRate >= 60 ? T.green : winRate > 0 ? T.amber : T.muted },
          { label: "Weight Updates", value: String(learningLog.length), sub: "by LearnerAgent" },
          { label: "Last Update", value: weights?.updated_at ? new Date(weights.updated_at).toLocaleDateString() : "—", sub: "signal weights" },
        ].map(s => (
          <div key={s.label} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px" }}>
            <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{s.label}</div>
            <div style={{ fontSize: "22px", fontWeight: 700, color: s.color ?? T.text }}>{s.value}</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px" }}>
        {(["accuracy", "weights", "equity"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: tab === t ? T.accent : T.card, color: tab === t ? "#fff" : T.muted, textTransform: "capitalize" }}>
            {t === "accuracy" ? "Accuracy Trend" : t === "weights" ? "Signal Weights" : "Equity Curve"}
          </button>
        ))}
      </div>

      {/* Accuracy trend */}
      {tab === "accuracy" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
          <Card title="Win Rate Over Time">
            {accData.length === 0
              ? <Empty msg="Accuracy builds after first trades close (7 days)" />
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
              ? <Empty msg="LearnerAgent hasn't adjusted weights yet" />
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
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
        <Card title="Paper Portfolio Equity Curve">
          {equityCurve.length === 0
            ? <Empty msg="Equity curve builds after first paper trades" />
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
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Learning Log</div>
        {fullLog.length === 0 ? (
          <Empty msg="LearnerAgent hasn't logged any outcomes yet. Runs Sunday 8 PM after trades close." />
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
      </div>
    </div>
  );
}
