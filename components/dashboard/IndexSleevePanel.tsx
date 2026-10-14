"use client";

import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { useMarket } from "@/lib/market-context";

// India index-ETF sleeve SHADOW on the Learning page: what the real India paper book would have returned with 10/20/30% of capital in
// NIFTYBEES, daily-rebalanced. No orders, no capital moved. Viewer-safe stored aggregates (/api/learning/index-sleeve). NOTE: this file must
// not import server-side modules (client bundle); all numbers arrive precomputed from the route.

type Metrics = { sessions: number; totalReturnPct: number; annVolPct: number; maxDrawdownPct: number; returnPerDrawdown: number | null };
type Vs = { sessions: number; beta: number | null; correlation: number | null; upCapturePct: number | null; downCapturePct: number | null; upDays: number; downDays: number; etfTotalReturnPct: number; trackingErrorAnnPct: number | null };
type Payload = {
  error?: string; sessions: number; firstDate?: string | null; lastDate?: string | null; instrument?: string;
  state: { state: "collecting" | "one_regime" | "measured"; text: string };
  book: Metrics | null; bookVsEtf: Vs | null; weights: Array<{ weight: number; sessions: number; metrics: Metrics | null }>;
};

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24" };
const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));

export default function IndexSleevePanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (market !== "india") return;
    let active = true;
    setData(null);
    fetch("/api/learning/index-sleeve", { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Sleeve evidence unavailable (${r.status})`); return r.json(); })
      .then((b) => { if (active) { setData(b); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Sleeve evidence unavailable"); });
    return () => { active = false; };
  }, [market]);

  if (market !== "india") return null;
  const stateColor = data?.state.state === "measured" ? T.green : T.amber;
  const vs = data?.bookVsEtf;
  const rows = data ? [{ label: "Actual book (0% index)", m: data.book }, ...data.weights.map((w) => ({ label: `${Math.round(w.weight * 100)}% NIFTYBEES sleeve`, m: w.metrics }))] : [];

  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, color: T.text, fontSize: 15, fontWeight: 700 }}><Layers size={16} color={T.accent} /> Index-ETF sleeve · India (shadow)</div>
      <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, marginTop: 6, maxWidth: 820 }}>
        What the India paper book would have returned if 10, 20 or 30% of capital had sat in NIFTYBEES, rebalanced daily. Nothing is bought and no capital moves.
        The question: does tracking the index more closely improve return per unit of risk, or just give up the book&apos;s own picks? Idealized: no fees or tracking error on the ETF.
      </div>
      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading sleeve shadow…</div>}
      {data && data.sessions === 0 && <div style={{ color: T.sub, fontSize: 12, marginTop: 12 }}>No sleeve shadow rows yet.</div>}
      {data && data.sessions > 0 && (
        <>
          <div style={{ marginTop: 12, padding: "8px 12px", borderRadius: 6, border: `1px solid ${T.border}`, color: stateColor, fontSize: 12, lineHeight: 1.5 }}>
            <strong>{data.state.state === "measured" ? "Readable" : data.state.state === "one_regime" ? "One market phase only" : "Collecting"}:</strong> {data.state.text}
            <span style={{ color: T.muted }}> {data.firstDate} → {data.lastDate} · {data.sessions} sessions</span>
          </div>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Version", "Total return", "Ann. volatility", "Max drawdown", "Return / drawdown"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                    <td style={{ padding: "5px 10px 5px 0" }}>{r.label}</td>
                    <td style={{ padding: "5px 10px 5px 0", color: (r.m?.totalReturnPct ?? 0) >= 0 ? T.green : T.red }}>{pct(r.m?.totalReturnPct)}</td>
                    <td style={{ padding: "5px 10px 5px 0" }}>{num(r.m?.annVolPct, 1)}%</td>
                    <td style={{ padding: "5px 10px 5px 0" }}>{pct(r.m?.maxDrawdownPct)}</td>
                    <td style={{ padding: "5px 10px 5px 0" }}>{num(r.m?.returnPerDrawdown)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {vs && (
            <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.7, marginTop: 14 }}>
              <strong style={{ color: T.text }}>Book vs NIFTYBEES:</strong> index {pct(vs.etfTotalReturnPct)} over the window · beta {num(vs.beta)} · correlation {num(vs.correlation)} ·
              captures {num(vs.upCapturePct, 0)}% of index gains ({vs.upDays} up days) and {num(vs.downCapturePct, 0)}% of index losses ({vs.downDays} down days) ·
              tracking error {num(vs.trackingErrorAnnPct, 1)}% a year.
            </div>
          )}
        </>
      )}
    </section>
  );
}
