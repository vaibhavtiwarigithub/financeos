"use client";

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { useMarket } from "@/lib/market-context";
import { councilSeriesReleaseLabel } from "@/lib/llm-model-catalog";

// LLM council (shadow) evidence on the Learning page: rank IC and t-stat per member, composite median, the deterministic
// baseline and the fixed 50/50 blend, on the SAME matured outcomes, plus daily coverage. Viewer-safe stored aggregates
// (/api/learning/council-ic). Legacy descriptive statistics, not validated ESS
// or an adoption verdict. New matched comparisons live in Prediction Lab.

type Cell = { horizon_days: number; series_key: string; forecast_model: string | null; cohort_key: string; observation_count: number; qualifying_sessions: number; independent_windows: number; mean_session_rank_ic: number | null; sd_session_rank_ic: number | null; t_stat: number | null; classification: string; reason: string };
type Coverage = { date: string; runs: number; completed: number; partial: number; failed: number; deepseek: number; claude: number; codex: number };
type Payload = { error?: string; evaluationBatchId: string | null; evaluatedAt: string | null; cells: Cell[]; coverage: Coverage[] };

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24" };
const COHORT_LABEL: Record<string, string> = {
  all_research_v1: "All research symbols (scored at each research slot)",
  near_threshold_entry_long_v1: "Near-threshold entry candidates (original predeclared slice)",
  forecast_available_close_v1: "Availability-aligned (label starts at the next close after each forecast was returned)",
  forecast_available_close_v2: "Availability-aligned v2 (expected next close, early-close aware, missing entry fails closed)",
};
const SERIES_LABEL = (key: string) => {
  key=key.split("|")[0];
  if (key === "composite:median") return "Council median";
  if (key === "composite:api_members_median") return "API members median";
  if (key === "composite:availability_median") return "Council median";
  if (key.startsWith("deterministic")) return "Deterministic score (same sample)";
  if (key.startsWith("blend")) return "50/50 blend (deterministic + council)";
  const parts = key.split(":");
  if (parts[0] === "model") return `${parts[1]} · ${parts[parts.length - 1] === "debated" ? "after debate" : "independent"}${parts[2] === "subscription" ? " · local worker" : " · API"}`;
  return key;
};
const num = (v: number | null, digits = 3) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(digits));

export default function CouncilIcPanel() {
  const { market } = useMarket();
  const [data, setData] = useState<Payload | null>(null);
  const [horizon, setHorizon] = useState(10);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setData(null);
    fetch(`/api/learning/council-ic?market=${market}`, { cache: "no-store" })
      .then(async (r) => { if (!r.ok) throw new Error(`Council evidence unavailable (${r.status})`); return r.json(); })
      .then((b) => { if (active) { setData(b); setError(""); } })
      .catch((e) => { if (active) setError(e instanceof Error ? e.message : "Council evidence unavailable"); });
    return () => { active = false; };
  }, [market]);

  const cohorts = useMemo(() => {
    const byCohort = new Map<string, Cell[]>();
    for (const c of (data?.cells ?? []).filter((x) => x.horizon_days === horizon)) {
      const list = byCohort.get(c.cohort_key) ?? []; list.push(c); byCohort.set(c.cohort_key, list);
    }
    return [...byCohort.entries()];
  }, [data, horizon]);

  const todaysCoverage = data?.coverage?.[0];

  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px 20px", marginBottom: "24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, color: T.text, fontSize: 15, fontWeight: 700 }}><Users size={16} color={T.accent} /> LLM Council · rank IC (shadow)</div>
          <div style={{ color: T.sub, fontSize: 12, lineHeight: 1.55, marginTop: 6, maxWidth: 820 }}>
            Does each model, and their median, rank {market === "india" ? "India" : "US"} symbols by their later benchmark-neutral return, compared with the deterministic score on the same sample?
            Measurement only: no trade, score or exit uses these scores. Short samples are labelled insufficient rather than shown as a verdict.
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {[2, 5, 10, 20].map((h) => (
            <button key={h} onClick={() => setHorizon(h)} style={{ background: h === horizon ? T.accent : "transparent", color: h === horizon ? "#fff" : T.sub, border: `1px solid ${T.border}`, borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>h{h}</button>
          ))}
        </div>
      </div>

      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 12 }}>{error}</div>}
      {!data && !error && <div style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>Loading council evidence…</div>}

      {data && (
        <>
          <div style={{ color: T.muted, fontSize: 11, marginTop: 10 }}>
            {data.evaluatedAt ? `Last evaluation ${new Date(data.evaluatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : "No evaluation yet"} ·
            {todaysCoverage ? ` latest scored day ${todaysCoverage.date}: ${todaysCoverage.runs} runs (${todaysCoverage.completed} complete, ${todaysCoverage.partial} partial, ${todaysCoverage.failed} failed)` : " no council runs in the last 14 days"}
          </div>

          {cohorts.length === 0 && <div style={{ color: T.sub, fontSize: 12, marginTop: 12 }}>No evaluated cells at h{horizon} yet. Returns need to mature (h{horizon} sessions after each score) before a rank IC exists.</div>}

          {cohorts.map(([cohort, cells]) => (
            <div key={cohort} style={{ marginTop: 16 }}>
              <div style={{ color: T.text, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{COHORT_LABEL[cohort] ?? cohort}</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: T.muted, textAlign: "left" }}>
                      {["Series", "Observations", "Sessions", "Rough windows (sessions/h)", "Mean rank IC", "Legacy descriptive t", "State"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {cells.map((c) => (
                      <tr key={`${c.series_key}-${c.cohort_key}`} style={{ borderTop: `1px solid ${T.border}`, color: T.text }} title={c.reason}>
                        <td style={{ padding: "5px 10px 5px 0" }} title={c.series_key}>{SERIES_LABEL(c.series_key)}<div style={{fontSize:11,color:T.muted,maxWidth:420}}>{councilSeriesReleaseLabel(c.series_key)}</div></td>
                        <td style={{ padding: "5px 10px 5px 0" }}>{c.observation_count}</td>
                        <td style={{ padding: "5px 10px 5px 0" }}>{c.qualifying_sessions}</td>
                        <td style={{ padding: "5px 10px 5px 0" }}>{num(c.independent_windows, 1)}</td>
                        <td style={{ padding: "5px 10px 5px 0", color: c.mean_session_rank_ic == null ? T.muted : c.mean_session_rank_ic >= 0 ? T.green : T.red }}>{num(c.mean_session_rank_ic)}</td>
                        <td style={{ padding: "5px 10px 5px 0" }}>{num(c.t_stat, 2)}</td>
                        <td style={{ padding: "5px 10px 5px 0", color: c.classification === "insufficient_evidence" ? T.amber : T.sub }}>{c.classification === "insufficient_evidence" ? "insufficient evidence" : "measured (descriptive)"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          <div style={{ color: T.text, fontSize: 12, fontWeight: 600, margin: "18px 0 6px" }}>Daily coverage (last 14 days): symbols scored per member</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr style={{ color: T.muted, textAlign: "left" }}>{["Day", "Runs", "Complete", "Partial", "Failed", "DeepSeek", "Claude", "Codex"].map((h) => <th key={h} style={{ padding: "4px 10px 4px 0", fontWeight: 400 }}>{h}</th>)}</tr></thead>
              <tbody>
                {data.coverage.map((c) => (
                  <tr key={c.date} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                    <td style={{ padding: "5px 10px 5px 0" }}>{c.date}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.runs}</td>
                    <td style={{ padding: "5px 10px 5px 0" }}>{c.completed}</td><td style={{ padding: "5px 10px 5px 0", color: c.partial ? T.amber : T.text }}>{c.partial}</td>
                    <td style={{ padding: "5px 10px 5px 0", color: c.failed ? T.red : T.text }}>{c.failed}</td>
                    <td style={{ padding: "5px 10px 5px 0" }}>{c.deepseek}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.claude}</td><td style={{ padding: "5px 10px 5px 0" }}>{c.codex}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
