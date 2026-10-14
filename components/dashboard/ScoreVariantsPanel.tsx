"use client";

import { useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import { useMarket } from "@/lib/market-context";

// Forward shadow of alternative score formulas on the Learning page. The variants were PRE-REGISTERED (see declared date); only observations
// after that date count as "forward" evidence. Earlier observations are shown separately and labelled hindsight, because the variants were
// chosen while looking at them. Viewer-safe stored aggregates (/api/learning/score-variants). Client component: no server-module imports.

type Cell = {
  variant_id: string; sample: "forward" | "hindsight"; horizon_days: number; sessions: number; avg_cross_section: number; independent_windows: number;
  variant_mean_ic: number | null; variant_ic_t: number | null; variant_top_fifth: number | null; variant_bottom_fifth: number | null; variant_spread: number | null; variant_spread_t: number | null;
  baseline_mean_ic: number | null; baseline_top_fifth: number | null; baseline_bottom_fifth: number | null; baseline_spread: number | null;
  classification: string; meets_adoption_gate: boolean; reason: string;
};
type Registry = { variant_id: string; label: string; weights: Record<string, number>; declared_at: string; rationale: string };
type Payload = { error?: string; evaluatedAt: string | null; declaredAt: string | null; registry: Registry[]; cells: Cell[] };

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24" };
const pct = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const num = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const fmtWeights = (w: Record<string, number>) => Object.entries(w).map(([k, v]) => `${k} ${v}`).join(" · ");

export default function ScoreVariantsPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Payload | null>(null);
  const [horizon, setHorizon] = useState(10);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setData(null);
    fetch(`/api/learning/score-variants?market=${market}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Score variants unavailable (${r.status})`); return r.json(); })
      .then((b) => { if (active) { setData(b); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Score variants unavailable"); });
    return () => { active = false; };
  }, [market]);

  const bySample = useMemo(() => {
    const pick = (sample: "forward" | "hindsight") => (data?.cells ?? []).filter((c) => c.sample === sample && c.horizon_days === horizon);
    return { forward: pick("forward"), hindsight: pick("hindsight") };
  }, [data, horizon]);
  const labelOf = (id: string) => data?.registry.find((r) => r.variant_id === id)?.label ?? id;
  const baselineRow = (cells: Cell[]) => cells[0];

  const table = (cells: Cell[], title: string, tone: string) => (
    <div style={{ marginTop: 16 }}>
      <div style={{ color: tone, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {cells.length === 0 || cells.every((c) => c.sessions === 0) ? (
        <div style={{ color: T.sub, fontSize: 12 }}>No qualifying sessions yet. {cells[0]?.reason ?? ""}</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Score", "Sessions", "Rank IC", "Top fifth", "Bottom fifth", "Spread", "Spread t", "State"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
            <tbody>
              {baselineRow(cells) && (
                <tr style={{ borderTop: `1px solid ${T.border}`, color: T.sub }}>
                  <td style={{ padding: "5px 10px 5px 0" }}>Live composite (same rows)</td><td style={{ padding: "5px 10px 5px 0" }}>{baselineRow(cells).sessions}</td>
                  <td style={{ padding: "5px 10px 5px 0" }}>{num(baselineRow(cells).baseline_mean_ic, 3)}</td>
                  <td style={{ padding: "5px 10px 5px 0" }}>{pct(baselineRow(cells).baseline_top_fifth)}</td><td style={{ padding: "5px 10px 5px 0" }}>{pct(baselineRow(cells).baseline_bottom_fifth)}</td>
                  <td style={{ padding: "5px 10px 5px 0", color: (baselineRow(cells).baseline_spread ?? 0) >= 0 ? T.green : T.red }}>{pct(baselineRow(cells).baseline_spread)}</td><td style={{ padding: "5px 10px 5px 0" }}>—</td><td style={{ padding: "5px 10px 5px 0" }}>baseline</td>
                </tr>
              )}
              {cells.map((c) => (
                <tr key={c.variant_id} style={{ borderTop: `1px solid ${T.border}`, color: T.text }} title={c.reason}>
                  <td style={{ padding: "5px 10px 5px 0" }}>{labelOf(c.variant_id)}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.sessions}</td>
                  <td style={{ padding: "5px 10px 5px 0" }}>{num(c.variant_mean_ic, 3)}</td>
                  <td style={{ padding: "5px 10px 5px 0" }}>{pct(c.variant_top_fifth)}</td><td style={{ padding: "5px 10px 5px 0" }}>{pct(c.variant_bottom_fifth)}</td>
                  <td style={{ padding: "5px 10px 5px 0", color: (c.variant_spread ?? 0) >= 0 ? T.green : T.red }}>{pct(c.variant_spread)}</td>
                  <td style={{ padding: "5px 10px 5px 0" }}>{num(c.variant_spread_t, 2)}</td>
                  <td style={{ padding: "5px 10px 5px 0", color: c.meets_adoption_gate ? T.green : c.classification === "insufficient_evidence" ? T.amber : T.sub }}>
                    {c.meets_adoption_gate ? "clears adoption gate" : c.classification === "insufficient_evidence" ? "insufficient evidence" : "measured, gate not met"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "18px 20px", marginBottom: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: T.text, fontSize: 15, fontWeight: 700 }}><FlaskConical size={16} color={T.accent} /> Score formulas · forward shadow</div>
          <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, marginTop: 6, maxWidth: 820 }}>
            Does a simpler score rank {market === "india" ? "India" : "US"} stocks better than the live composite? Three formulas were declared in advance
            {data?.declaredAt ? ` (${new Date(data.declaredAt).toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""} and are judged only on observations after that moment, so they cannot be tuned in hindsight.
            Spread = average 10-day (or 5-day) excess return of the top fifth of names by the score minus the bottom fifth. Measurement only: no score, gate or trade uses these.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[5, 10].map((h) => (
            <button key={h} onClick={() => setHorizon(h)} style={{ background: h === horizon ? T.accent : "transparent", color: h === horizon ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>h{h}</button>
          ))}
        </div>
      </div>
      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading score variants…</div>}
      {data && (
        <>
          <div style={{ color: T.muted, fontSize: 11, marginTop: 10 }}>
            {data.evaluatedAt ? `Last evaluation ${new Date(data.evaluatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "No evaluation yet"} ·
            Verdict needs 20+ sessions and 12 effective windows (sessions ÷ horizon): about 3 months at h5 and 6 months at h10 of forward data. Adoption also needs spread t ≥ 2.4 (3 variants tested).
          </div>
          {table(bySample.forward, "FORWARD (counts as evidence): observations after the formulas were declared", T.green)}
          {table(bySample.hindsight, "HINDSIGHT (reference only): observations before declaration, which the formulas were chosen from", T.amber)}
          <div style={{ marginTop: 16, color: T.muted, fontSize: 11, lineHeight: 1.7 }}>
            {data.registry.map((r) => (
              <div key={r.variant_id}><strong style={{ color: T.sub }}>{r.label}</strong> ({fmtWeights(r.weights)}): {r.rationale}</div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
