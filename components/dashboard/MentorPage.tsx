"use client";
import { useState, useEffect, useRef } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import MentorCoachPanel from "@/components/dashboard/MentorCoachPanel";
import SymbolAutocomplete from "@/components/dashboard/SymbolAutocomplete";
import AiAttribution from "@/components/dashboard/AiAttribution";
import { fmtMoney, type Mkt } from "@/lib/format-money";
import LearningPage from "@/components/dashboard/LearningPage";
import { navReturnPct, paperStartNav } from "@/lib/paper-nav";
import {
  ResponsiveContainer, LineChart as LC, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine, Label,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
} from "recharts";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#1C1F26",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2D1B00",
  blue: "#60A5FA",
};

function ScoreBar({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  const color = value >= 70 ? T.green : value >= 55 ? T.amber : T.red;
  return (
    <div style={{ marginBottom: "6px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "3px", fontSize: "11px" }}>
        <span style={{ color: T.muted }}>{label}</span>
        <span style={{ color, fontWeight: 600 }}>{value}</span>
      </div>
      <div style={{ height: "4px", background: T.border, borderRadius: "2px" }}>
        <div style={{ height: "100%", width: `${value}%`, background: color, borderRadius: "2px" }} />
      </div>
    </div>
  );
}

function DecisionCard({ packet, signal, trade, market }: { packet: any; signal?: any; trade?: any; market: Mkt }) {
  const [open, setOpen] = useState(false);
  const outcome = trade?.outcome;
  const outcomeColor = outcome === "win" ? T.green : outcome === "loss" ? T.red : outcome === "breakeven" ? T.amber : T.muted;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", marginBottom: "12px", overflow: "hidden" }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{ padding: "16px 20px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ fontWeight: 800, fontSize: "15px", color: T.accent }}>{packet.symbol}</div>
          {packet.is_held_position && (
            <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: T.accentBg, color: T.accent }}>HELD</span>
          )}
          {signal && (
            <span style={{ fontSize: "11px", fontWeight: 600, color: signal.direction === "long" ? T.green : T.amber }}>
              {signal.direction?.toUpperCase()} · score {signal.analyst_score}
            </span>
          )}
          <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px", background: "#2D1B00", color: "#FBBF24", letterSpacing: "0.04em" }}>PAPER</span>
          {trade && outcome && (
            <span style={{ fontSize: "10px", fontWeight: 700, padding: "2px 6px", borderRadius: "4px",
              background: outcome === "win" ? T.greenBg : outcome === "loss" ? T.redBg : T.amberBg,
              color: outcomeColor }}>
              {outcome.toUpperCase()} {trade.pnl_pct != null ? (trade.pnl_pct >= 0 ? "+" : "") + trade.pnl_pct.toFixed(1) + "%" : ""}
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "11px", color: T.muted }}>{new Date(packet.created_at).toLocaleDateString()}</span>
          <span style={{ color: T.muted, fontSize: "14px" }}>{open ? "▾" : "▸"}</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 20px 20px", borderTop: `1px solid ${T.border}` }}>
          {/* What the agent thought */}
          {packet.summary && (
            <div style={{ marginTop: "16px" }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>What the agent saw</div>
              <p style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.6", margin: 0 }}>{packet.summary}</p>
            </div>
          )}

          {/* Score breakdown */}
          <div style={{ marginTop: "16px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "24px" }}>
            <div>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Score breakdown</div>
              <ScoreBar label="Fundamental" value={packet.fundamental_score} />
              <ScoreBar label="Technical" value={packet.technical_score} />
              <ScoreBar label="Sentiment" value={packet.sentiment_score} />
              <ScoreBar label="Macro" value={packet.macro_score} />
              <ScoreBar label="Insider" value={packet.insider_score} />
            </div>
            <div>
              {packet.catalysts && (
                <>
                  <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Catalysts</div>
                  <p style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5", margin: "0 0 12px" }}>{packet.catalysts}</p>
                </>
              )}
              {packet.key_risks && (
                <>
                  <div style={{ fontSize: "11px", color: T.red, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>Key risks</div>
                  <p style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5", margin: 0 }}>{packet.key_risks}</p>
                </>
              )}
            </div>
          </div>

          {/* Trade result */}
          {trade && (
            <div style={{ marginTop: "16px", padding: "12px 14px", background: outcome === "win" ? T.greenBg : outcome === "loss" ? T.redBg : T.dim, borderRadius: "8px", borderLeft: `3px solid ${outcomeColor}` }}>
              <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Trade outcome</div>
              <div style={{ fontSize: "13px", color: T.text }}>
                Bought {trade.qty}sh @ {trade.fill_price != null ? fmtMoney(trade.fill_price, market) : "—"}
                {trade.exit_price != null ? ` → sold @ ${fmtMoney(trade.exit_price, market)}` : " (open)"}
                {trade.realized_pnl != null ? ` · ${trade.realized_pnl >= 0 ? "+" : ""}${fmtMoney(trade.realized_pnl, market)}` : ""}
              </div>
              {trade.rationale && (
                <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.6", whiteSpace: "pre-wrap", marginTop: "6px" }}>
                  {trade.rationale}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LearningEmpty({ msg }: { msg: string }) {
  return <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "32px 0" }}>{msg}</div>;
}

function LearningCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>{title}</div>
      {children}
    </div>
  );
}

function LearningCustomTip({ active, payload, label }: any) {
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

function LearningContent({
  fullLog,
  performance,
  weights,
  allTrades,
  market,
}: {
  fullLog: any[];
  performance: any[];
  weights: any;
  allTrades: any[];
  /** `performance` / `allTrades` are already scoped to this book upstream. */
  market: Mkt;
}) {
  const [innerTab, setInnerTab] = useState<"accuracy" | "weights" | "equity">("accuracy");

  const totalTrades = allTrades.length;
  const wins = allTrades.filter((t: any) => t.outcome === "win").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  // learningLog = weight change rows (from weight_snapshot diffs — not available here, use empty)
  const learningLog: any[] = [];

  const weightBars = weights ? [
    { signal: "Fundamental", value: +(weights.fundamental_weight * 100).toFixed(1) },
    { signal: "Technical",   value: +(weights.technical_weight   * 100).toFixed(1) },
    { signal: "Sentiment",   value: +(weights.sentiment_weight   * 100).toFixed(1) },
    { signal: "Macro",       value: +(weights.macro_weight       * 100).toFixed(1) },
    { signal: "Insider",     value: +(weights.insider_weight     * 100).toFixed(1) },
  ] : [];

  // Return % is measured against THIS market's own paper seed ($10k / ₹10L).
  const equityCurve = performance.map((p: any) => ({
    date: p.date.slice(5),
    nav: fmtMoney(p.nav, market),
    return: navReturnPct(p.nav, market),
  }));

  const accData = performance
    .filter((p: any) => p.win_rate !== null)
    .map((p: any) => ({ date: p.date.slice(5), winRate: +(p.win_rate! * 100).toFixed(1) }));

  return (
    <div>
      {/* Agent Pipeline Diagram */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Agent Pipeline</div>
        <svg viewBox="0 0 700 160" width="100%" style={{ display: "block", maxWidth: "700px" }} xmlns="http://www.w3.org/2000/svg">
          <rect x="8" y="60" width="90" height="44" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="53" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">Holdings</text>
          <text x="53" y="91" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">(read-only)</text>
          <line x1="98" y1="82" x2="126" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <rect x="126" y="56" width="108" height="52" rx="8" fill="#6366F1" />
          <text x="180" y="74" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">ResearchAgent</text>
          <text x="180" y="87" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">9 AM weekdays</text>
          <text x="180" y="99" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">FinancialDatasets + AlphaVantage</text>
          <line x1="234" y1="82" x2="262" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <rect x="262" y="62" width="90" height="40" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="307" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">agent_signals</text>
          <text x="307" y="92" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">3 per day</text>
          <line x1="352" y1="82" x2="382" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <text x="367" y="75" textAnchor="middle" fill="#34D399" fontSize="8" fontFamily="Inter,sans-serif">score ≥ 60</text>
          <rect x="382" y="58" width="96" height="48" rx="8" fill="#6366F1" />
          <text x="430" y="79" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">PaperTrader</text>
          <text x="430" y="93" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">approval_required</text>
          <line x1="478" y1="82" x2="506" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <rect x="506" y="62" width="84" height="40" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="548" y="78" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">paper_trades</text>
          <text x="548" y="92" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">7-day horizon</text>
          <line x1="590" y1="82" x2="612" y2="82" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <rect x="612" y="58" width="82" height="48" rx="8" fill="#6366F1" />
          <text x="653" y="79" textAnchor="middle" fill="#ECEDEF" fontSize="10" fontWeight="600" fontFamily="Inter,sans-serif">LearnerAgent</text>
          <text x="653" y="93" textAnchor="middle" fill="#C7D2FE" fontSize="8.5" fontFamily="Inter,sans-serif">Sunday 8 PM</text>
          <line x1="653" y1="106" x2="653" y2="124" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <rect x="614" y="124" width="78" height="28" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="653" y="141" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">learning_log</text>
          <rect x="104" y="120" width="110" height="32" rx="6" fill="#1A1D27" stroke="#252836" strokeWidth="1.5" />
          <text x="159" y="133" textAnchor="middle" fill="#9B9EA8" fontSize="9.5" fontFamily="Inter,sans-serif">Screener</text>
          <text x="159" y="145" textAnchor="middle" fill="#6B7280" fontSize="8.5" fontFamily="Inter,sans-serif">3 candidates / day</text>
          <line x1="159" y1="120" x2="180" y2="108" stroke="#4B5563" strokeWidth="1.5" markerEnd="url(#arr2)" />
          <defs>
            <marker id="arr2" markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#4B5563" />
            </marker>
          </defs>
        </svg>
      </div>

      {/* How analyst_score works */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>How analyst_score works</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
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

      {/* Inner tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch" }}>
        {(["accuracy", "weights", "equity"] as const).map(t => (
          <button key={t} onClick={() => setInnerTab(t)} style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: innerTab === t ? T.accent : T.card, color: innerTab === t ? "#fff" : T.muted, textTransform: "capitalize", flexShrink: 0, whiteSpace: "nowrap" }}>
            {t === "accuracy" ? "Accuracy Trend" : t === "weights" ? "Signal Weights" : "Equity Curve"}
          </button>
        ))}
      </div>

      {/* Accuracy trend */}
      {innerTab === "accuracy" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
          <LearningCard title="Win Rate Over Time">
            {accData.length === 0
              ? <LearningEmpty msg="Accuracy builds after first trades close (7 days)" />
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <LC data={accData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} />
                    <Tooltip content={<LearningCustomTip />} />
                    <ReferenceLine y={60} stroke={T.accent} strokeDasharray="4 4" label={{ value: "60% target", fill: T.accent, fontSize: 10, position: "right" }} />
                    <Line type="monotone" dataKey="winRate" name="Win %" stroke={T.green} strokeWidth={2} dot={false} />
                  </LC>
                </ResponsiveContainer>
              )}
          </LearningCard>

          <LearningCard title="Weight Change Log">
            {learningLog.length === 0
              ? <LearningEmpty msg="LearnerAgent hasn't adjusted weights yet" />
              : (
                <div style={{ maxHeight: "220px", overflowY: "auto" }}>
                  {learningLog.map((row: any, i: number) => (
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
          </LearningCard>
        </div>
      )}

      {/* Signal weights */}
      {innerTab === "weights" && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
          <LearningCard title="Current Signal Weights">
            {weightBars.length === 0
              ? <LearningEmpty msg="No weights configured" />
              : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={weightBars} layout="vertical" margin={{ top: 0, right: 30, left: 60, bottom: 0 }}>
                    <CartesianGrid stroke={T.border} strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" domain={[0, 40]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} unit="%" />
                    <YAxis type="category" dataKey="signal" tick={{ fontSize: 11, fill: T.textSub }} tickLine={false} axisLine={false} width={80} />
                    <Tooltip content={<LearningCustomTip />} />
                    <Bar dataKey="value" name="Weight" radius={[0, 4, 4, 0]}>
                      {weightBars.map((_: any, i: number) => (
                        <Cell key={i} fill={[T.accent, T.green, T.amber, "#60A5FA", "#A78BFA"][i % 5]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
          </LearningCard>

          <LearningCard title="Weight Evolution">
            {learningLog.length < 2
              ? <LearningEmpty msg="Need 2+ weight changes to show evolution" />
              : (() => {
                const signals = [...new Set(learningLog.map((r: any) => r.signal_adjusted))];
                const byDate = learningLog.reduce((acc: any, row: any) => {
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
                      <Tooltip content={<LearningCustomTip />} />
                      {signals.map((s: any, i: number) => (
                        <Line key={s} type="monotone" dataKey={s} name={s} stroke={colors[i % 5]} strokeWidth={2} dot={false} />
                      ))}
                    </LC>
                  </ResponsiveContainer>
                );
              })()}
          </LearningCard>
        </div>
      )}

      {/* Equity curve */}
      {innerTab === "equity" && (
        <LearningCard title={`Paper Portfolio Equity Curve · ${market === "india" ? "India" : "US"} book vs ${fmtMoney(paperStartNav(market), market, 0)} seed`}>
          {equityCurve.length === 0
            ? <LearningEmpty msg={`No ${market === "india" ? "India" : "US"} paper performance yet — the curve builds after this book's first paper trades.`} />
            : (
              <ResponsiveContainer width="100%" height={280}>
                <LC data={equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={40} unit="%" />
                  <Tooltip content={<LearningCustomTip />} />
                  <ReferenceLine y={0} stroke={T.muted} strokeDasharray="4 4" />
                  <Line type="monotone" dataKey="return" name="Return %" stroke={T.green} strokeWidth={2} dot={false} />
                </LC>
              </ResponsiveContainer>
            )}
        </LearningCard>
      )}

      {/* Full Learning Log */}
      <div style={{ marginTop: "24px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
        <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>Learning Log</div>
        {fullLog.length === 0 ? (
          <LearningEmpty msg="LearnerAgent hasn't logged any outcomes yet. Runs Sunday 8 PM after trades close." />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {fullLog.map((entry: any, i: number) => {
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
  );
}

const DIM_META: Record<string, { label: string; short: string; color: string; desc: string }> = {
  sector_awareness:     { label: "Sector Awareness",     short: "Sector",    color: "#60A5FA", desc: "Picking sectors aligned with macro / rotation" },
  emotional_discipline: { label: "Emotional Discipline", short: "Emotion",   color: "#F87171", desc: "Avoiding FOMO, panic, revenge trading" },
  risk_management:      { label: "Risk Management",      short: "Risk Mgmt", color: "#34D399", desc: "Stop loss, sizing, concentration limits" },
  thesis_quality:       { label: "Thesis Quality",       short: "Thesis",    color: "#A78BFA", desc: "Clear catalyst, falsifiable, data-backed" },
  entry_timing:         { label: "Entry Timing",         short: "Timing",    color: "#FBBF24", desc: "Not chasing, not too early, logical setup" },
  big_picture:          { label: "Big Picture",          short: "Macro",     color: "#F97316", desc: "Trading with macro regime, Fed, tape" },
};
const DIM_KEYS = Object.keys(DIM_META) as (keyof typeof DIM_META)[];

const STARTER_QUESTIONS = [
  "What is your current market thesis and what assumptions are you making?",
  "Walk me through why you picked your top-scored symbol this week.",
  "What mistakes have you made and what did you learn from them?",
  "What would change your mind on a position you're currently bullish on?",
  "How should I think about the difference between a score of 62 vs 78?",
];

export default function MentorPage({ packets, trades, fullLog, signals, performance, weights, allTrades, market }: {
  packets: any[]; trades: any[]; fullLog: any[]; signals: any[];
  performance: any[]; weights: any; allTrades: any[];
  /** Book this page is rendering. Server already scoped every market-bearing
   *  query to it; used here for currency, NAV seed and the thesis fetch. */
  market: Mkt;
}) {
  const [tab, setTab] = useState<"coach" | "ask" | "decisions" | "learning" | "journal" | "dimensions">("coach");
  const [thesis, setThesis] = useState<string | null>(null);
  const [thesisMeta, setThesisMeta] = useState<any>(null);
  const [thesisLoading, setThesisLoading] = useState(true);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [askMeta, setAskMeta] = useState<any>(null);
  const [asking, setAsking] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);

  // Judgment Coach state
  const [jSymbol, setJSymbol] = useState("");
  const [jAction, setJAction] = useState<"buy" | "sell" | "watching">("buy");
  const [jType, setJType] = useState<"pre_trade_thesis" | "post_trade">("pre_trade_thesis");
  const [jReasoning, setJReasoning] = useState("");
  const [jSubmitting, setJSubmitting] = useState(false);
  const [jResult, setJResult] = useState<any>(null);
  const [jMeta, setJMeta] = useState<any>(null);
  const [jError, setJError] = useState<string | null>(null);
  const [jHistory, setJHistory] = useState<any[]>([]);
  const [jHistoryLoading, setJHistoryLoading] = useState(false);
  const [jHistoryLoaded, setJHistoryLoaded] = useState(false);

  // Score history state
  const [scoreHistory, setScoreHistory] = useState<Array<{ date: string; score: number; count: number; topVerdict: string | null }>>([]);
  const [scoreLoading, setScoreLoading] = useState(true);

  // Dimension state
  const [dimData, setDimData] = useState<{ averages: Record<string, number>; timeSeries: any[]; weakest: string; strongest: string; latestObs: any[]; total: number } | null>(null);
  const [dimLoading, setDimLoading] = useState(true);
  const [dimTab, setDimTab] = useState<string>("sector_awareness");

  useEffect(() => {
    fetch("/api/mentor/scores")
      .then(r => r.json())
      .then(d => { setScoreHistory(d.scores ?? []); setScoreLoading(false); })
      .catch(() => setScoreLoading(false));
    fetch("/api/mentor/dimensions")
      .then(r => r.json())
      .then(d => { setDimData(d); setDimLoading(false); })
      .catch(() => setDimLoading(false));
  }, []);

  useEffect(() => {
    if (tab !== "journal" || jHistoryLoaded) return;
    setJHistoryLoading(true);
    fetch("/api/mentor/journal")
      .then(r => r.json())
      .then(d => { setJHistory(d.entries ?? []); setJHistoryLoaded(true); setJHistoryLoading(false); })
      .catch(() => setJHistoryLoading(false));
  }, [tab, jHistoryLoaded]);

  async function submitJudgment() {
    if (jSubmitting || !jSymbol.trim() || jReasoning.trim().length < 50) return;
    setJSubmitting(true);
    setJResult(null);
    setJMeta(null);
    setJError(null);
    try {
      const res = await fetch("/api/mentor/evaluate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: jSymbol.trim().toUpperCase(),
          action: jAction,
          entry_type: jType,
          user_reasoning: jReasoning.trim(),
        }),
      });
      const data = await res.json();
      if (data.error) { setJError(data.error); return; }
      setJResult(data.evaluation);
      setJMeta(data.meta ?? data.evaluation?.meta ?? null);
      setJHistoryLoaded(false); // force reload history
    } catch (e: any) {
      setJError(e.message ?? "Unknown error");
    } finally {
      setJSubmitting(false);
    }
  }

  // Thesis is per-market (the API caches one entry per book) — refetch when the
  // global switcher moves, otherwise India would keep showing the US thesis.
  useEffect(() => {
    setThesisLoading(true);
    fetch(`/api/mentor/thesis?market=${market}`)
      .then(r => r.json())
      .then(d => { setThesis(d.thesis ?? null); setThesisMeta(d.meta ?? null); setThesisLoading(false); })
      .catch(() => setThesisLoading(false));
  }, [market]);

  async function ask(q?: string) {
    const text = (q ?? question).trim();
    if (!text || asking) return;
    setQuestion("");
    setAnswer("");
    setAskMeta(null);
    setAsking(true);
    setTab("ask");

    try {
      const res = await fetch("/api/mentor/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            if (payload === "[DONE]") break;
            try {
              const parsed = JSON.parse(payload);
              const { text: chunk, error, meta } = parsed;
              if (error) { setAnswer(prev => prev + `\n\n[Error: ${error}]`); break; }
              if (meta) {
                // First meta event carries { agent, agentKind, model }; the final
                // one carries { toolsUsed, steps }. Merge both into askMeta.
                setAskMeta((prev: any) => ({ ...(prev ?? {}), ...meta }));
              }
              if (chunk) {
                setAnswer(prev => prev + chunk);
                answerRef.current?.scrollIntoView({ behavior: "smooth" });
              }
            } catch { /* skip malformed */ }
          }
        }
      }
    } finally {
      setAsking(false);
    }
  }

  // Build decision cards: match packets → signals → trades by symbol
  const signalMap = new Map(signals.map(s => [s.symbol, s]));
  const tradeMap = new Map(trades.map(t => [t.symbol, t]));
  const seenSymbols = new Set<string>();
  const decisionCards = packets.filter(p => {
    if (seenSymbols.has(p.symbol)) return false;
    seenSymbols.add(p.symbol);
    return true;
  });

  const TABS = [
    { key: "coach", label: "AI Coach" },
    { key: "ask", label: "Ask the Agent" },
    { key: "decisions", label: "Decision Log" },
    { key: "learning", label: "Learning" },
    { key: "journal", label: "Judgment Coach" },
    { key: "dimensions", label: "Behavior Profile" },
  ] as const;

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif" }}>

      <PageHeader
        title="Mentor"
        subtitle="Why the agent does what it does"
        cadence="as-needed"
        whatItDoes="Explains the reasoning behind every agent signal and trade. Ask it anything about a position, a score, or the market thesis. Uses your real portfolio context for personalized answers."
        whatToLookFor={[
          "Current Market Thesis — updated daily by the agent. Challenge it if it looks wrong.",
          "Ask about specific signals: 'Why did the agent buy NVDA?' or 'Why score 72?'",
          "Learning packets show what the agent absorbed from past trade outcomes.",
          "If answers seem generic, add more symbols to your watchlist for richer context.",
        ]}
      />
      <div style={{ padding: "0 clamp(12px, 4vw, 28px) 32px" }}>

      {/* ── Judgment Score History ───────────────────────────────────────── */}
      {(() => {
        const latest = scoreHistory[scoreHistory.length - 1];
        const prev = scoreHistory[scoreHistory.length - 2];
        const currentScore = latest?.score ?? null;
        const trend = currentScore != null && prev ? currentScore - prev.score : null;
        const scoreColor = currentScore == null ? T.muted : currentScore >= 70 ? T.green : currentScore >= 50 ? T.amber : T.red;

        return (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
              <div>
                <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.10em", textTransform: "uppercase", marginBottom: "8px" }}>Your Judgment Score</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "10px" }}>
                  {scoreLoading ? (
                    <span style={{ fontSize: "42px", fontWeight: 800, color: T.muted }}>—</span>
                  ) : currentScore == null ? (
                    <span style={{ fontSize: "20px", color: T.muted }}>No evaluations yet</span>
                  ) : (
                    <>
                      <span style={{ fontSize: "clamp(34px,11vw,52px)", fontWeight: 800, color: scoreColor, lineHeight: 1, fontFamily: "monospace" }}>{currentScore}</span>
                      <span style={{ fontSize: "16px", color: T.muted }}>/100</span>
                      {trend != null && (
                        <span style={{ fontSize: "14px", fontWeight: 700, color: trend > 0 ? T.green : trend < 0 ? T.red : T.muted }}>
                          {trend > 0 ? `▲ +${trend}` : trend < 0 ? `▼ ${trend}` : "→ no change"}
                        </span>
                      )}
                    </>
                  )}
                </div>
                {currentScore != null && (
                  <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>
                    {currentScore >= 70 ? "Expert range — strong reasoning quality" : currentScore >= 50 ? "Proficient range — improving" : "Learning range — keep submitting theses"}
                  </div>
                )}
              </div>
              <div style={{ display: "flex", gap: "16px", fontSize: "11px", color: T.muted, alignItems: "center" }}>
                <span><span style={{ color: T.red }}>●</span> Learning (&lt;50)</span>
                <span><span style={{ color: T.amber }}>●</span> Proficient (50–70)</span>
                <span><span style={{ color: T.green }}>●</span> Expert (70+)</span>
              </div>
            </div>

            {scoreLoading ? (
              <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>Loading score history…</div>
            ) : scoreHistory.length < 2 ? (
              <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>
                Make 2+ judgments in the <strong style={{ color: T.textSub }}>Judgment Coach</strong> tab to see your progress chart.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <LC data={scoreHistory} margin={{ top: 8, right: 24, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={30} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const d = payload[0].payload;
                      const sc = d.score;
                      const c = sc >= 70 ? T.green : sc >= 50 ? T.amber : T.red;
                      return (
                        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "12px" }}>
                          <div style={{ color: T.muted, marginBottom: "4px" }}>{label}</div>
                          <div style={{ color: c, fontWeight: 700, fontSize: "16px", fontFamily: "monospace" }}>{sc} / 100</div>
                          <div style={{ color: T.muted, marginTop: "2px" }}>{d.count} evaluation{d.count !== 1 ? "s" : ""} that day</div>
                          {d.topVerdict && <div style={{ color: T.textSub, marginTop: "2px", textTransform: "capitalize" }}>Top verdict: {d.topVerdict}</div>}
                        </div>
                      );
                    }}
                  />
                  <ReferenceLine y={50} stroke={T.red} strokeDasharray="4 3" strokeOpacity={0.6}>
                    <Label value="Learning" position="right" fill={T.red} fontSize={9} />
                  </ReferenceLine>
                  <ReferenceLine y={70} stroke={T.amber} strokeDasharray="4 3" strokeOpacity={0.6}>
                    <Label value="Proficient" position="right" fill={T.amber} fontSize={9} />
                  </ReferenceLine>
                  <ReferenceLine y={90} stroke={T.green} strokeDasharray="4 3" strokeOpacity={0.6}>
                    <Label value="Expert" position="right" fill={T.green} fontSize={9} />
                  </ReferenceLine>
                  <Line
                    type="monotone"
                    dataKey="score"
                    name="Score"
                    stroke={T.accent}
                    strokeWidth={2.5}
                    dot={{ fill: T.accent, strokeWidth: 0, r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LC>
              </ResponsiveContainer>
            )}
          </div>
        );
      })()}

      {/* Current market thesis */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "24px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: T.muted, letterSpacing: "0.10em", textTransform: "uppercase" }}>Current Market Thesis</div>
          <button onClick={() => { setThesisLoading(true); fetch(`/api/mentor/thesis?bust=1&market=${market}`).then(r => r.json()).then(d => { setThesis(d.thesis ?? null); setThesisMeta(d.meta ?? null); setThesisLoading(false); }).catch(() => setThesisLoading(false)); }}
            style={{ fontSize: "11px", color: T.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            ↻ refresh
          </button>
        </div>
        {thesisLoading ? (
          <div style={{ color: T.muted, fontSize: "13px" }}>Generating thesis from latest research… (may take ~90s)</div>
        ) : thesis ? (
          <>
            <p style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7", margin: 0, whiteSpace: "pre-wrap" }}>{thesis}</p>
            {thesisMeta?.agent && thesisMeta?.model && (
              <div style={{ marginTop: "12px" }}>
                <AiAttribution agent={thesisMeta.agent} model={thesisMeta.model} agentKind={thesisMeta.agentKind} />
              </div>
            )}
          </>
        ) : (
          <div style={{ color: T.muted, fontSize: "13px" }}>
            No research data yet. Run ResearchAgent first — go to <a href="/dashboard/agents" style={{ color: T.accent }}>Agents →</a>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", overflowX: "auto", flexWrap: "nowrap", WebkitOverflowScrolling: "touch" }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: "8px 18px", borderRadius: "8px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none",
              background: tab === t.key ? T.accent : T.card, color: tab === t.key ? "#fff" : T.muted, flexShrink: 0, whiteSpace: "nowrap" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Ask the Agent tab */}
      {tab === "coach" && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "14px", padding: "20px clamp(14px,4vw,24px)" }}>
          <MentorCoachPanel />
        </div>
      )}

      {tab === "ask" && (
        <div>
          {/* Starter questions */}
          {!answer && !asking && (
            <div style={{ marginBottom: "20px" }}>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "10px" }}>Start with one of these:</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                {STARTER_QUESTIONS.map(q => (
                  <button key={q} onClick={() => ask(q)}
                    style={{ fontSize: "12px", padding: "8px 14px", borderRadius: "20px", border: `1px solid ${T.border}`, background: T.card, color: T.textSub, cursor: "pointer", textAlign: "left", maxWidth: "340px" }}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Answer display */}
          {(answer || asking) && (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px", marginBottom: "20px" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap", marginBottom: "12px" }}>
                <div style={{ fontSize: "11px", color: T.accent, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  ◐ Agent Response {asking && <span style={{ color: T.muted }}>(thinking…)</span>}
                </div>
                {askMeta?.agent && askMeta?.model && (
                  <AiAttribution agent={askMeta.agent} model={askMeta.model} agentKind={askMeta.agentKind} toolsUsed={askMeta.toolsUsed} steps={askMeta.steps} />
                )}
              </div>
              <div style={{ fontSize: "14px", color: T.text, lineHeight: "1.7", whiteSpace: "pre-wrap" }}>
                {answer}
                {asking && <span style={{ color: T.muted }}>▌</span>}
              </div>
              <div ref={answerRef} />
            </div>
          )}

          {/* Input */}
          <div style={{ display: "flex", gap: "10px" }}>
            <textarea
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } }}
              placeholder="Ask anything — why it bought X, what assumptions it's making, why a trade lost, what you should watch for…"
              disabled={asking}
              rows={3}
              style={{ flex: 1, background: T.card, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "12px 14px", color: T.text, fontSize: "13px", resize: "none", outline: "none", fontFamily: "'Inter', sans-serif", lineHeight: "1.5" }}
            />
            <button
              onClick={() => ask()}
              disabled={asking || !question.trim()}
              style={{ padding: "0 22px", borderRadius: "10px", background: asking ? T.dim : T.accent, color: "#fff", border: "none", cursor: asking ? "not-allowed" : "pointer", fontWeight: 600, fontSize: "13px", whiteSpace: "nowrap" }}>
              {asking ? "Thinking…" : "Ask →"}
            </button>
          </div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>Enter to send · Shift+Enter for new line · Response streams in ~30-90s</div>
        </div>
      )}

      {/* Decision Log tab */}
      {tab === "decisions" && (
        <div>
          {decisionCards.length === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No research yet</div>
              <div style={{ fontSize: "13px", color: T.muted }}>
                Run ResearchAgent to start building the decision log. <a href="/dashboard/agents" style={{ color: T.accent }}>Go to Agents →</a>
              </div>
            </div>
          ) : (
            <>
              <div style={{ fontSize: "12px", color: T.muted, marginBottom: "14px" }}>
                {decisionCards.length} symbols researched · Click any card to see full reasoning, score breakdown, and trade outcome
              </div>
              {decisionCards.map(p => (
                <DecisionCard
                  key={p.id}
                  packet={p}
                  signal={signalMap.get(p.symbol)}
                  trade={tradeMap.get(p.symbol)}
                  market={market}
                />
              ))}
            </>
          )}
        </div>
      )}

      {/* Behavior Profile tab */}
      {tab === "dimensions" && (
        <div>
          {dimLoading ? (
            <div style={{ color: T.muted, fontSize: "13px", padding: "40px", textAlign: "center" }}>Loading behavior data…</div>
          ) : !dimData || dimData.total === 0 ? (
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
              <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "8px" }}>No behavior data yet</div>
              <div style={{ fontSize: "13px", color: T.muted }}>Submit a thesis in <strong style={{ color: T.textSub }}>Judgment Coach</strong> to start tracking your behavior dimensions.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

              {/* Coach Panel */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
                <div style={{ background: T.card, border: `1px solid ${T.red}40`, borderRadius: "12px", padding: "18px" }}>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: T.red, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Weakest Area</div>
                  <div style={{ fontSize: "18px", fontWeight: 700, color: T.text, marginBottom: "4px" }}>{DIM_META[dimData.weakest]?.label}</div>
                  <div style={{ fontSize: "22px", fontWeight: 800, color: T.red, fontFamily: "monospace", marginBottom: "8px" }}>{dimData.averages[dimData.weakest]} / 100</div>
                  <div style={{ fontSize: "12px", color: T.muted, marginBottom: "10px" }}>{DIM_META[dimData.weakest]?.desc}</div>
                  {dimData.latestObs.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      <div style={{ fontSize: "10px", color: T.muted, fontWeight: 600, textTransform: "uppercase" }}>Recent observations:</div>
                      {dimData.latestObs.slice(0, 3).map((o, i) => (
                        <div key={i} style={{ fontSize: "11px", color: T.textSub, background: T.surface, borderRadius: "6px", padding: "6px 8px", borderLeft: `2px solid ${T.red}` }}>
                          <span style={{ color: T.accent, fontWeight: 600 }}>{o.symbol}</span> — {o.text}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div style={{ background: T.card, border: `1px solid ${T.green}40`, borderRadius: "12px", padding: "18px" }}>
                  <div style={{ fontSize: "10px", fontWeight: 700, color: T.green, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "8px" }}>Strongest Area</div>
                  <div style={{ fontSize: "18px", fontWeight: 700, color: T.text, marginBottom: "4px" }}>{DIM_META[dimData.strongest]?.label}</div>
                  <div style={{ fontSize: "22px", fontWeight: 800, color: T.green, fontFamily: "monospace", marginBottom: "8px" }}>{dimData.averages[dimData.strongest]} / 100</div>
                  <div style={{ fontSize: "12px", color: T.muted }}>{DIM_META[dimData.strongest]?.desc}</div>
                </div>
              </div>

              {/* Radar chart */}
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "4px" }}>Behavior Radar (last 30 days)</div>
                <div style={{ fontSize: "12px", color: T.muted, marginBottom: "16px" }}>Average score per dimension — 100 is expert, 50 is baseline</div>
                <ResponsiveContainer width="100%" height={320}>
                  <RadarChart cx="50%" cy="50%" outerRadius="75%"
                    data={DIM_KEYS.map(k => ({ subject: DIM_META[k].short, value: dimData.averages[k] ?? 50, fullMark: 100 }))}>
                    <PolarGrid stroke={T.border} />
                    <PolarAngleAxis dataKey="subject" tick={{ fill: T.textSub, fontSize: 11, fontWeight: 600 }} />
                    <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: T.muted, fontSize: 9 }} />
                    <Radar name="You" dataKey="value" stroke={T.accent} fill={T.accent} fillOpacity={0.25} strokeWidth={2} />
                    <Tooltip
                      content={({ payload }) => {
                        if (!payload?.length) return null;
                        const d = payload[0];
                        const key = DIM_KEYS.find(k => DIM_META[k].short === (d.payload as any).subject);
                        const v = d.value as number;
                        return (
                          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", fontSize: "12px" }}>
                            <div style={{ fontWeight: 600, color: T.text, marginBottom: "2px" }}>{key ? DIM_META[key].label : d.name}</div>
                            <div style={{ color: v >= 70 ? T.green : v >= 50 ? T.amber : T.red, fontWeight: 700, fontFamily: "monospace" }}>{v} / 100</div>
                            {key && <div style={{ color: T.muted, marginTop: "2px", fontSize: "11px" }}>{DIM_META[key].desc}</div>}
                          </div>
                        );
                      }}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>

              {/* Dimension score bars */}
              <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "16px" }}>All Dimensions</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {DIM_KEYS.map(dim => {
                    const v = dimData.averages[dim] ?? 50;
                    const meta = DIM_META[dim];
                    const col = v >= 70 ? T.green : v >= 50 ? T.amber : T.red;
                    return (
                      <div key={dim}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                          <div>
                            <span style={{ fontSize: "13px", fontWeight: 600, color: T.text, marginRight: "8px" }}>{meta.label}</span>
                            <span style={{ fontSize: "11px", color: T.muted }}>{meta.desc}</span>
                          </div>
                          <span style={{ fontSize: "14px", fontWeight: 800, color: col, fontFamily: "monospace" }}>{v}</span>
                        </div>
                        <div style={{ height: "6px", background: T.border, borderRadius: "3px" }}>
                          <div style={{ height: "100%", width: `${v}%`, background: col, borderRadius: "3px", transition: "width 0.3s" }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Per-dimension history chart */}
              {dimData.timeSeries.length >= 2 && (
                <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
                  <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "12px" }}>Dimension History</div>
                  <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "16px" }}>
                    {DIM_KEYS.map(dim => (
                      <button key={dim} onClick={() => setDimTab(dim)}
                        style={{ padding: "5px 12px", borderRadius: "6px", fontSize: "11px", fontWeight: 600, cursor: "pointer", border: "none",
                          background: dimTab === dim ? DIM_META[dim].color : T.surface,
                          color: dimTab === dim ? "#fff" : T.muted }}>
                        {DIM_META[dim].short}
                      </button>
                    ))}
                  </div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LC data={dimData.timeSeries} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid stroke={T.border} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: T.muted }} tickLine={false} axisLine={false} width={28} />
                      <Tooltip content={<LearningCustomTip />} />
                      <ReferenceLine y={50} stroke={T.muted} strokeDasharray="4 3" strokeOpacity={0.4} />
                      <ReferenceLine y={70} stroke={T.green} strokeDasharray="4 3" strokeOpacity={0.4} />
                      <Line type="monotone" dataKey={dimTab} name={DIM_META[dimTab]?.label ?? dimTab}
                        stroke={DIM_META[dimTab]?.color ?? T.accent} strokeWidth={2.5}
                        dot={{ fill: DIM_META[dimTab]?.color ?? T.accent, strokeWidth: 0, r: 4 }} activeDot={{ r: 6 }} />
                    </LC>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Learning tab */}
      {tab === "learning" && (
        <LearningPage
          showHeader={false}
          learningLog={[]}
          fullLog={fullLog}
          performance={performance}
          weights={weights}
          totalTrades={allTrades.length}
          winRate={allTrades.length > 0 ? (allTrades.filter((t: any) => t.outcome === "win").length / allTrades.length) * 100 : 0}
          market={market}
        />
      )}

      {/* Judgment Coach tab */}
      {tab === "journal" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>

          {/* Explainer */}
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "18px 20px" }}>
            <div style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>
              <strong style={{ color: T.text }}>Test your thesis</strong> — write out why you want to buy, sell, or watch a stock. It scores your REASONING 0–100 against five weighted criteria and shows what each one cost you. It does <strong style={{ color: T.text }}>not</strong> fetch live market data: any claim that depends on current prices or multiples is marked unverified rather than checked, so a confident wrong number can still score well on structure. Takes ~60–90s — a reasoning model thinks before it answers.
            </div>
          </div>

          {/* Input form */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
            <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "18px" }}>
              Submit Your Thesis
            </div>

            {/* Symbol + action + type row */}
            <div style={{ display: "flex", gap: "12px", marginBottom: "16px", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 160px", minWidth: "140px" }}>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px" }}>Symbol</div>
                <SymbolAutocomplete
                  value={jSymbol}
                  onChange={setJSymbol}
                  placeholder="AAPL"
                  inputStyle={{ fontWeight: 700, fontFamily: "monospace" }}
                />
              </div>
              <div style={{ flex: "0 0 130px" }}>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px" }}>Action</div>
                <select
                  value={jAction}
                  onChange={e => setJAction(e.target.value as any)}
                  style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", color: T.text, fontSize: "13px", outline: "none" }}
                >
                  <option value="buy">Buy</option>
                  <option value="sell">Sell</option>
                  <option value="watching">Watching</option>
                </select>
              </div>
              <div style={{ flex: "0 0 200px" }}>
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "6px" }}>Entry Type</div>
                <select
                  value={jType}
                  onChange={e => setJType(e.target.value as any)}
                  style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 12px", color: T.text, fontSize: "13px", outline: "none" }}
                >
                  <option value="pre_trade_thesis">Pre-trade (thinking about it)</option>
                  <option value="post_trade">Post-trade (already acted)</option>
                </select>
              </div>
            </div>

            {/* Reasoning */}
            <div style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}>
                <div style={{ fontSize: "11px", color: T.muted }}>Your reasoning <span style={{ color: T.red }}>*</span></div>
                <div style={{ fontSize: "11px", color: jReasoning.length < 50 ? T.red : T.green }}>
                  {jReasoning.length} / 50 min
                </div>
              </div>
              <textarea
                value={jReasoning}
                onChange={e => setJReasoning(e.target.value)}
                placeholder="Explain your thesis in detail — what data made you bullish/bearish, what catalysts you see, what would make you wrong, your price target or exit plan. The more specific, the better your score."
                rows={6}
                style={{ width: "100%", background: T.surface, border: `1px solid ${jReasoning.length > 0 && jReasoning.length < 50 ? T.red : T.border}`, borderRadius: "10px", padding: "12px 14px", color: T.text, fontSize: "13px", resize: "vertical", outline: "none", fontFamily: "'Inter', sans-serif", lineHeight: "1.6", boxSizing: "border-box" }}
              />
            </div>

            <button
              onClick={submitJudgment}
              disabled={jSubmitting || !jSymbol.trim() || jReasoning.trim().length < 50}
              style={{
                padding: "10px 28px", borderRadius: "10px", fontWeight: 700, fontSize: "13px", cursor: (jSubmitting || !jSymbol.trim() || jReasoning.trim().length < 50) ? "not-allowed" : "pointer",
                background: (jSubmitting || !jSymbol.trim() || jReasoning.trim().length < 50) ? T.dim : T.accent,
                color: "#fff", border: "none",
              }}
            >
              {jSubmitting ? "AI Evaluating… (30-90s)" : "Evaluate My Thesis →"}
            </button>
            {jSubmitting && (
              <div style={{ marginTop: "10px", fontSize: "12px", color: T.muted }}>
                AI is evaluating your reasoning on {jSymbol} — clarity, risk-awareness, and biases…
              </div>
            )}
          </div>

          {/* Error */}
          {jError && (
            <div style={{ background: T.redBg, border: `1px solid ${T.red}40`, borderRadius: "10px", padding: "14px 18px", color: T.red, fontSize: "13px" }}>
              Error: {jError}
            </div>
          )}

          {/* Result card */}
          {jResult && (() => {
            const score = jResult.score ?? 0;
            const scoreColor = score >= 75 ? T.green : score >= 50 ? T.amber : T.red;
            const verdictColors: Record<string, string> = { strong: T.green, sound: T.green, mixed: T.amber, flawed: T.red, emotional: T.red };
            const vc = verdictColors[jResult.verdict] ?? T.muted;
            return (
              <div style={{ background: T.card, border: `2px solid ${scoreColor}40`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)" }}>
                {jMeta?.agent && jMeta?.model && (
                  <div style={{ marginBottom: "14px" }}>
                    <AiAttribution agent={jMeta.agent} model={jMeta.model} agentKind={jMeta.agentKind} />
                  </div>
                )}
                {/* Score header */}
                <div style={{ display: "flex", alignItems: "center", gap: "20px", marginBottom: "20px", flexWrap: "wrap" }}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: "clamp(34px,11vw,52px)", fontWeight: 800, color: scoreColor, lineHeight: 1, fontFamily: "monospace" }}>{score}</div>
                    <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>/ 100</div>
                  </div>
                  <div>
                    <div style={{ fontSize: "11px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "4px" }}>Verdict</div>
                    <span style={{ fontSize: "15px", fontWeight: 700, color: vc, textTransform: "uppercase" }}>{jResult.verdict}</span>
                    {jResult.bias_flags?.length > 0 && (
                      <div style={{ marginTop: "8px", display: "flex", gap: "6px", flexWrap: "wrap" }}>
                        {jResult.bias_flags.map((b: string) => (
                          <span key={b} style={{ fontSize: "10px", fontWeight: 700, padding: "2px 8px", borderRadius: "4px", background: T.redBg, color: T.red, textTransform: "uppercase", letterSpacing: "0.04em" }}>{b.replace(/_/g, " ")}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  {jResult.data_used && (
                    <div style={{ marginLeft: "auto", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px", fontSize: "11px", color: T.muted, maxWidth: "260px" }}>
                      <div style={{ fontWeight: 600, color: T.textSub, marginBottom: "4px" }}>Could not verify</div>
                      {jResult.data_used}
                    </div>
                  )}
                </div>

                {/* Rubric breakdown: priority-ordered, with the points each criterion
                    cost. A bare "68/100" is unactionable — you cannot fix a thesis
                    whose marking you cannot see. Ordered by points LOST, so the first
                    bullet is always the one worth the most to fix next. */}
                {jResult.rubric_normalised?.lines?.length > 0 && (
                  <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px 16px", marginBottom: "16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: "8px", marginBottom: "10px" }}>
                      <div style={{ fontSize: "11px", fontWeight: 700, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Where the points went — biggest fix first
                      </div>
                      <div style={{ fontSize: "11px", color: T.muted }}>
                        {jResult.rubric_normalised.total}/100 from the breakdown
                        {jResult.rubric_normalised.discrepancy ? (
                          <span style={{ color: T.amber }}> · model claimed {jResult.rubric_normalised.reportedScore}, parts sum to {jResult.rubric_normalised.total}</span>
                        ) : null}
                      </div>
                    </div>
                    <ol style={{ margin: 0, paddingLeft: "18px", display: "flex", flexDirection: "column", gap: "9px" }}>
                      {jResult.rubric_normalised.lines.map((line: any) => (
                        <li key={line.key} style={{ color: T.textSub, fontSize: "12.5px", lineHeight: 1.55 }}>
                          <span style={{ color: T.text, fontWeight: 650 }}>{line.label}</span>
                          <span style={{
                            marginLeft: "8px", fontSize: "11px", fontWeight: 700, fontVariantNumeric: "tabular-nums",
                            color: line.pointsLost === 0 ? T.green : line.pointsLost >= line.pointsAvailable / 2 ? T.red : T.amber,
                          }}>
                            {line.pointsAwarded}/{line.pointsAvailable}
                            {line.pointsLost > 0 ? ` · −${line.pointsLost}` : " · full marks"}
                          </span>
                          <div style={{ marginTop: "2px" }}>{line.finding}</div>
                          <div style={{ color: T.muted, fontSize: "11px", marginTop: "2px" }}>{line.asks}</div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}

                {/* Three-panel breakdown */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "16px", marginBottom: "16px" }}>
                  {[
                    { label: "✓ What's Right", text: jResult.what_is_right, color: T.green, bg: T.greenBg },
                    { label: "✗ What's Wrong", text: jResult.what_is_wrong, color: T.red, bg: T.redBg },
                    { label: "Bear Case", text: jResult.bear_case, color: T.amber, bg: T.amberBg },
                  ].map(p => p.text ? (
                    <div key={p.label} style={{ background: p.bg, border: `1px solid ${p.color}30`, borderRadius: "8px", padding: "14px" }}>
                      <div style={{ fontSize: "10px", fontWeight: 700, color: p.color, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>{p.label}</div>
                      <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{p.text}</div>
                    </div>
                  ) : null)}
                </div>

                {/* Suggestions */}
                {jResult.suggestions && (
                  <div style={{ background: T.accentBg, border: `1px solid ${T.accent}30`, borderRadius: "8px", padding: "14px" }}>
                    <div style={{ fontSize: "10px", fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "6px" }}>How to Improve</div>
                    <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.7", whiteSpace: "pre-wrap" }}>{jResult.suggestions}</div>
                  </div>
                )}

                {/* Dimension scores */}
                {jResult.dimensions && (
                  <div style={{ marginTop: "16px" }}>
                    <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "10px" }}>Behavior Dimensions</div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "8px" }}>
                      {DIM_KEYS.map(dim => {
                        const v = jResult.dimensions[dim] ?? 50;
                        const meta = DIM_META[dim];
                        const col = v >= 70 ? T.green : v >= 50 ? T.amber : T.red;
                        const obs = jResult.dimension_observations?.[dim];
                        return (
                          <div key={dim} style={{ background: T.surface, borderRadius: "8px", padding: "10px 12px", borderLeft: `3px solid ${meta.color}` }}>
                            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                              <span style={{ fontSize: "11px", fontWeight: 600, color: T.textSub }}>{meta.label}</span>
                              <span style={{ fontSize: "13px", fontWeight: 800, color: col, fontFamily: "monospace" }}>{v}</span>
                            </div>
                            <div style={{ height: "3px", background: T.border, borderRadius: "2px", marginBottom: "6px" }}>
                              <div style={{ height: "100%", width: `${v}%`, background: col, borderRadius: "2px" }} />
                            </div>
                            {obs && <div style={{ fontSize: "11px", color: T.muted, lineHeight: "1.4" }}>{obs}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* History */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
            <div style={{ fontSize: "11px", color: T.muted, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "14px" }}>
              Past Evaluations
            </div>
            {jHistoryLoading ? (
              <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>Loading…</div>
            ) : jHistory.length === 0 ? (
              <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0", textAlign: "center" }}>No evaluations yet. Submit your first thesis above.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                {jHistory.map((e: any) => {
                  const sc = e.ai_score ?? 0;
                  const scColor = sc >= 75 ? T.green : sc >= 50 ? T.amber : T.red;
                  const vc: Record<string, string> = { strong: T.green, sound: T.green, mixed: T.amber, flawed: T.red, emotional: T.red };
                  return (
                    <div key={e.id} style={{ display: "flex", alignItems: "flex-start", gap: "14px", background: T.surface, borderRadius: "10px", padding: "14px 16px" }}>
                      <div style={{ fontSize: "24px", fontWeight: 800, color: scColor, fontFamily: "monospace", minWidth: "42px", textAlign: "center" }}>{sc}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px", flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700, color: T.accent }}>{e.symbol}</span>
                          <span style={{ fontSize: "11px", fontWeight: 600, padding: "1px 6px", borderRadius: "4px", background: T.card, color: T.textSub }}>{e.action?.toUpperCase()}</span>
                          {e.verdict && <span style={{ fontSize: "11px", fontWeight: 700, color: vc[e.verdict] ?? T.muted, textTransform: "uppercase" }}>{e.verdict}</span>}
                          {e.bias_flags?.map((b: string) => (
                            <span key={b} style={{ fontSize: "10px", padding: "1px 5px", borderRadius: "3px", background: T.redBg, color: T.red }}>{b.replace(/_/g, " ")}</span>
                          ))}
                          <span style={{ fontSize: "11px", color: T.muted, marginLeft: "auto" }}>{new Date(e.created_at).toLocaleDateString()}</span>
                        </div>
                        <div style={{ fontSize: "12px", color: T.muted, lineHeight: "1.5" }}>
                          {e.user_reasoning}
                        </div>
                        {e.suggestions && (
                          <div style={{ fontSize: "11px", color: T.accent, marginTop: "4px", lineHeight: "1.5" }}>
                            Tip: {e.suggestions}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
