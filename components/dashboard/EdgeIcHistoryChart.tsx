"use client";
// IC-over-time chart for /dashboard/edges — the "latest window only" table
// above this answers "what's the IC right now"; this answers "is it getting
// better." Reads edge_ic_history rows the server component already fetched;
// no new collection, no schema change.
import { useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from "recharts";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24", surface: "#13151C",
};
const MARKET_COLOR: Record<string, string> = { us: T.accent, india: T.amber };

export interface IcHistoryRow {
  edge_id: string;
  market: string;
  window_end: string;
  horizon: number;
  ic: number | null;
  t_stat: number | null;
}

export default function EdgeIcHistoryChart({ rows, edges }: { rows: IcHistoryRow[]; edges: { edge_id: string; name: string }[] }) {
  const [edgeId, setEdgeId] = useState<string>(edges[0]?.edge_id ?? "");
  const [horizon, setHorizon] = useState<5 | 10 | 20>(10);

  const { data, hasData } = useMemo(() => {
    const filtered = rows.filter(r => r.edge_id === edgeId && r.horizon === horizon);
    const byWindow = new Map<string, Record<string, any>>();
    for (const r of filtered) {
      if (!byWindow.has(r.window_end)) byWindow.set(r.window_end, { window_end: r.window_end });
      byWindow.get(r.window_end)![r.market] = r.ic == null ? null : Number(r.ic);
    }
    const sorted = [...byWindow.values()].sort((a, b) => String(a.window_end).localeCompare(String(b.window_end)));
    return { data: sorted, hasData: filtered.length > 0 };
  }, [rows, edgeId, horizon]);

  const markets = useMemo(() => [...new Set(rows.filter(r => r.edge_id === edgeId).map(r => r.market))], [rows, edgeId]);

  if (edges.length === 0) return null;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "4px" }}>
        <div style={{ fontSize: "14px", fontWeight: 600 }}>IC History <span style={{ fontSize: "11px", color: T.muted, fontWeight: 400 }}>· is this edge getting better or worse over time?</span></div>
        <div style={{ display: "flex", gap: "8px" }}>
          <select value={edgeId} onChange={e => setEdgeId(e.target.value)} style={{ background: T.surface, color: T.text, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "5px 8px", fontSize: "12px" }}>
            {edges.map(e => <option key={e.edge_id} value={e.edge_id}>{e.name}</option>)}
          </select>
          {[5, 10, 20].map(h => (
            <button key={h} onClick={() => setHorizon(h as 5 | 10 | 20)} style={{ padding: "5px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none", background: horizon === h ? T.accent : T.surface, color: horizon === h ? "#fff" : T.muted }}>
              {h}d
            </button>
          ))}
        </div>
      </div>
      <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>
        Weekly rank-IC per window. Positive = the edge ranked winners above losers that week. A rising line across many windows is what "getting better" looks like here — a single week is noise either direction.
      </div>
      {!hasData ? (
        <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>No history yet for this edge/horizon.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={T.border} />
            <XAxis dataKey="window_end" tick={{ fill: T.muted, fontSize: 10 }} />
            <YAxis tick={{ fill: T.muted, fontSize: 10 }} />
            <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: T.textSub }} />
            <Legend wrapperStyle={{ fontSize: 11, color: T.muted }} />
            <ReferenceLine y={0} stroke={T.muted} strokeDasharray="2 2" />
            {markets.map(m => (
              <Line key={m} type="monotone" dataKey={m} name={m.toUpperCase()} stroke={MARKET_COLOR[m] ?? T.text} strokeWidth={2} dot={{ r: 2 }} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
