"use client";

import { useEffect, useState } from "react";
import { Activity, ShieldCheck } from "lucide-react";
import { useMarket } from "@/lib/market-context";

type Finding = { subject_type: "dimension" | "agent" | "collaboration"; subject_key: string; finding_type: string; classification: string; metrics: Record<string, unknown>; reason: string };
type Run = { id: number; horizon_days: number; status: string; input_observation_count: number; distinct_session_count: number; created_at: string; dimension_diagnostic_findings: Finding[] };
type Response = { runs: Run[]; influence: string };

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", amber: "#FBBF24", green: "#34D399" };

function latestByHorizon(runs: Run[]) {
  const seen = new Set<number>();
  return runs.filter((run) => !seen.has(run.horizon_days) && !!seen.add(run.horizon_days));
}

export default function DimensionDiagnosticsSummary() {
  const { market } = useMarket();
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fetch(`/api/agents/dimension-diagnostics?market=${market}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Diagnostics unavailable (${response.status})`);
        return response.json();
      })
      .then((body) => { if (active) { setData(body); setError(""); } })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Diagnostics unavailable"); });
    return () => { active = false; };
  }, [market]);

  const runs = latestByHorizon(data?.runs ?? []);
  const latest = runs[0];
  const agentFinding = latest?.dimension_diagnostic_findings.find((finding) => finding.subject_type === "agent");
  const collaboration = latest?.dimension_diagnostic_findings.find((finding) => finding.subject_type === "collaboration");

  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px 20px", marginBottom: "24px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "7px", color: T.text, fontSize: "15px", fontWeight: 700 }}><Activity size={16} color={T.accent} /> Dimension and Agent Diagnostics</div>
        <div style={{ color: T.sub, fontSize: "12px", lineHeight: 1.55, marginTop: "6px", maxWidth: "760px" }}>Market-local measurement of data quality, scoring behavior and agent contribution. It cannot change a score, agent, strategy, paper position, live trade, exit or broker order.</div>
      </div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: T.sub, fontSize: "11px" }}><ShieldCheck size={14} color={T.green} /> Measure-only</div>
    </div>
    {error ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "14px" }}>{error}. The scheduled diagnostic will retry; no trading behavior is affected.</div>
      : !latest ? <div style={{ color: T.muted, fontSize: "12px", marginTop: "14px" }}>No diagnostic run yet for this market. The next scheduled post-label run will create the first immutable record.</div>
      : <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", marginTop: "16px" }}>
          {runs.sort((a, b) => a.horizon_days - b.horizon_days).map((run) => <div key={run.id} style={{ background: "#13151C", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "11px" }}>
            <div style={{ color: T.text, fontSize: "13px", fontWeight: 650 }}>{run.horizon_days}-day labels</div>
            <div style={{ color: run.status === "measured" ? T.green : T.amber, fontSize: "11px", marginTop: "4px" }}>{run.status === "measured" ? "Descriptive only" : "Insufficient evidence"}</div>
            <div style={{ color: T.muted, fontSize: "11px", marginTop: "7px" }}>{run.input_observation_count} labels · {run.distinct_session_count} sessions</div>
          </div>)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "16px", marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
          <div><div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", fontWeight: 700, marginBottom: "5px" }}>Agent contribution</div><div style={{ color: T.sub, fontSize: "12px", lineHeight: 1.5 }}>{agentFinding?.reason ?? "No agent contribution result recorded."}</div></div>
          <div><div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", fontWeight: 700, marginBottom: "5px" }}>Collaboration</div><div style={{ color: T.sub, fontSize: "12px", lineHeight: 1.5 }}>{collaboration?.reason ?? "No collaboration result recorded."}</div></div>
        </div>
      </>}
  </section>;
}
