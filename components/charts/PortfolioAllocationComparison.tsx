"use client";
import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { ALLOCATION_LABELS, validateAllocation, type AllocationPolicy } from "@/lib/allocation/profiles";
import { compareAllocation, type AllocationBook } from "@/lib/allocation/comparison";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", amber: "#FBBF24", accent: "#818CF8" };
const COLORS = ["#6366F1", "#34D399", "#60A5FA", "#A78BFA", "#FBBF24", "#CBD5E1", "#FB923C", "#F472B6"];

function Donut({ title, data, empty }: { title: string; data: { name: string; value: number; color: string }[]; empty?: string | null }) {
  return <div style={{ minWidth: 0 }}><div style={{ color: T.text, textAlign: "center", fontSize: 13, fontWeight: 700 }}>{title}</div>
    {empty ? <div style={{ minHeight: 170, display: "flex", alignItems: "center", color: T.amber, fontSize: 12, padding: 16 }} role="status">{empty}</div> : <div aria-label={`${title} allocation chart`} role="img" style={{ height: 180 }}>
      <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data.filter(d => d.value > 0)} dataKey="value" nameKey="name" innerRadius={48} outerRadius={72} isAnimationActive={false}>
        {data.filter(d => d.value > 0).map(d => <Cell key={d.name} fill={d.color} />)}
      </Pie><Tooltip formatter={(value: any) => `${Number(value).toFixed(1)}%`} contentStyle={{ background: T.card, border: `1px solid ${T.border}`, color: T.text, fontSize: 12 }} itemStyle={{ color: T.text }} /></PieChart></ResponsiveContainer>
    </div>}
  </div>;
}

export default function PortfolioAllocationComparison({ market, book, current }: { market: "us" | "india"; book: "paper" | "live"; current: AllocationBook | null }) {
  const [loaded, setLoaded] = useState<{ market: string; policy: AllocationPolicy } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setLoaded(null); setError(null);
    fetch(`/api/settings/risk-profile?section=allocation&market=${market}&view=policy`, { cache: "no-store" })
      .then(async r => { const d = await r.json(); if (!r.ok || validateAllocation(d.policy, market)) throw Error("Saved allocation goals are unavailable."); return d.policy as AllocationPolicy; })
      .then(policy => { if (active) setLoaded({ market, policy }); }).catch(() => { if (active) setError("Saved allocation goals could not be loaded. No default goal was substituted."); });
    return () => { active = false; };
  }, [market, retry]);
  const policy = loaded?.market === market ? loaded.policy : null;
  const mix = policy ? compareAllocation(policy, current) : null;
  const target = mix?.rows.map((r, i) => ({ name: ALLOCATION_LABELS[r.bucket], value: r.targetPct, color: COLORS[i] })) ?? [];
  const actual = [...(mix?.rows.map((r, i) => ({ name: ALLOCATION_LABELS[r.bucket], value: r.currentPct ?? 0, color: COLORS[i] })) ?? []), ...(mix?.extra.map((r, i) => ({ name: r.label, value: r.pct, color: i ? "#475569" : "#94A3B8" })) ?? [])];
  const partial = Boolean(mix?.extra.length);
  return <section aria-label="Portfolio goal versus current allocation" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20, marginBottom: 20, minWidth: 0 }}>
    <h3 style={{ margin: "0 0 6px", fontSize: 14, color: T.text }}>Portfolio mix · goal vs current</h3>
    <div style={{ fontSize: 12, color: T.sub, lineHeight: 1.6 }}>{market === "us" ? "US · USD" : "India · INR"} · {book === "paper" ? "Paper portfolio" : "Live portfolio"}{policy ? ` · ${policy.profile} · revision ${policy.revision}` : ""}</div>
    {!policy ? <div role="status" style={{ color: T.amber, marginTop: 12, fontSize: 12 }}>{error ?? "Loading saved goals…"}{error && <button onClick={() => setRetry(v => v + 1)} style={{ marginLeft: 8, background: "transparent", border: `1px solid ${T.border}`, borderRadius: 6, color: T.accent, padding: "5px 9px", cursor: "pointer" }}>Retry goals</button>}</div> : <>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: T.sub }}>{book === "live" ? "Saved paper goal shown for reference. It does not control or rebalance live orders." : policy.enabled ? "Saved goals guide future paper buys and top-ups. Research, cash and risk checks can prevent the goal being reached." : "Allocation guidance is OFF. These saved goals are inactive."} {book === "live" && !policy.enabled ? "The saved paper guidance is also OFF." : ""}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,180px),1fr))", gap: 8 }}>
        <Donut title={policy.enabled ? "Goal" : "Saved goal · inactive"} data={target} />
        <Donut title="Current" data={actual} empty={mix?.error} />
      </div>
      <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, textAlign: "left" }}>
        <caption style={{ textAlign: "left", color: T.muted, padding: "4px 0 8px" }}>{partial ? "Unclassified balances make category shares minimums (≥); gaps are withheld until classification is complete." : "Gap = goal minus current, in percentage points. Positive means below goal."}</caption>
        <thead><tr>{["Category", "Goal", "Current", "Gap"].map(label => <th key={label} style={{ padding: "6px 4px", color: T.sub, borderBottom: `1px solid ${T.border}` }}>{label}</th>)}</tr></thead>
        <tbody>{mix?.rows.map((r, i) => <tr key={r.bucket}><td style={{ padding: "7px 4px", color: T.text }}><span aria-hidden style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: COLORS[i], marginRight: 6 }} />{ALLOCATION_LABELS[r.bucket]}</td><td style={{ color: T.text }}>{r.targetPct.toFixed(1)}%</td><td style={{ color: T.text }}>{r.currentPct == null ? "—" : `${partial ? "≥" : ""}${r.currentPct.toFixed(1)}%`}</td><td style={{ color: T.sub }}>{r.currentPct == null || partial ? "—" : `${r.targetPct - r.currentPct > 0 ? "+" : ""}${(r.targetPct - r.currentPct).toFixed(1)}`}</td></tr>)}
          {mix?.extra.map(r => <tr key={r.label}><td style={{ padding: "7px 4px", color: T.amber }}>{r.label}</td><td>—</td><td style={{ color: T.amber }}>{r.pct.toFixed(1)}%</td><td>—</td></tr>)}</tbody>
      </table></div>
      {current?.asOf && <div style={{ color: T.muted, fontSize: 10, marginTop: 12 }}>Source snapshot: {new Date(current.asOf).toLocaleString()}. For multiple accounts, this is the oldest included snapshot.</div>}
      {current?.note && <p style={{ color: T.sub, fontSize: 11, lineHeight: 1.5 }}>{current.note}</p>}
      <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.5 }}>Tactical combines cash and leveraged positions; leverage is not added twice. Gold miners and energy stocks remain equities. Percentages show fund categories, not constituent look-through. <a href="/dashboard/settings?tab=trading" style={{ color: T.accent }}>Change goals in Settings → Trading</a></p>
    </>}
  </section>;
}
