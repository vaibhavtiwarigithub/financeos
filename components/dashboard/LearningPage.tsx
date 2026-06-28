"use client";
import { useState } from "react";
import { lazy, Suspense } from "react";
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
  performance,
  weights,
  totalTrades,
  winRate,
}: {
  learningLog: WeightRow[];
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
    <div style={{ padding: "28px", color: T.text, fontFamily: "'Inter', sans-serif" }}>
      <div style={{ marginBottom: "24px" }}>
        <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "6px" }}>Agent Intelligence</div>
        <h1 style={{ fontSize: "24px", fontWeight: 700, letterSpacing: "-0.02em" }}>Learning</h1>
      </div>

      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "16px", marginBottom: "24px" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" }}>
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
    </div>
  );
}
