"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  green: "#34D399", amber: "#FBBF24", red: "#F87171",
};

interface HistoricalSummary {
  plan?: { dateFrom?: string; dateThrough?: string };
  coverage?: { evaluatedDates?: number; medianCrossSection?: number | null };
  aggregate?: {
    n?: number; meanIc?: number; sigmaIc?: number;
    icIr?: number | null; tHac?: number | null;
  } | null;
  limitations?: string[];
}

interface HistoricalRun {
  id: string;
  market: "us" | "india";
  edge_id: string;
  horizon_sessions: number;
  data_cutoff: string;
  code_version: string;
  completed_at: string | null;
  result_summary: HistoricalSummary | null;
  dataset_fingerprint: string | null;
  run_fingerprint: string | null;
}

function number(value: number | null | undefined, digits = 3) {
  return value == null || !Number.isFinite(value) ? "Unavailable" : value.toFixed(digits);
}

export default function HistoricalReplayPanel({ market }: { market: "us" | "india" }) {
  const [runs, setRuns] = useState<HistoricalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agents/backtest/historical", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Historical ledger unavailable");
      setRuns(Array.isArray(body.runs) ? body.runs : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Historical ledger unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = runs.filter((run) => run.market === market);

  return (
    <section style={{ marginBottom: "18px", borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`, padding: "16px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "13px", color: T.text, fontWeight: 700 }}>Historical Evidence Runs</div>
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>Immutable local evidence ledger · diagnostic only</div>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh historical runs"
          aria-label="Refresh historical runs"
          style={{ width: "34px", height: "34px", display: "grid", placeItems: "center", background: T.surface, color: T.sub, border: `1px solid ${T.border}`, borderRadius: "6px", cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1 }}
        >
          <RefreshCw size={15} aria-hidden="true" />
        </button>
      </div>

      {error && <div style={{ color: T.red, fontSize: "12px" }}>{error}</div>}
      {!error && loading && <div style={{ color: T.muted, fontSize: "12px" }}>Loading ledger...</div>}
      {!error && !loading && visible.length === 0 && (
        <div style={{ color: T.sub, fontSize: "12px", background: T.surface, border: `1px solid ${T.border}`, padding: "12px 14px", borderRadius: "6px" }}>
          No {market === "india" ? "India" : "US"} local historical run is recorded.
          {market === "us" && " Survivor-safe adjusted US prices remain unbound."}
        </div>
      )}

      {!error && visible.map((run) => {
        const summary = run.result_summary;
        const aggregate = summary?.aggregate;
        const complete = Boolean(run.completed_at && summary);
        return (
          <div key={run.id} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "14px 16px", marginTop: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: "13px", color: T.text, fontWeight: 700 }}>{run.edge_id.replaceAll("_", " ")}</div>
                <div style={{ fontSize: "11px", color: T.sub, marginTop: "3px" }}>
                  {summary?.plan?.dateFrom ?? "Unknown"} to {summary?.plan?.dateThrough ?? run.data_cutoff} · {run.horizon_sessions} sessions · {run.market.toUpperCase()}
                </div>
              </div>
              <span style={{ fontSize: "10px", fontWeight: 700, color: complete ? T.green : T.amber, border: `1px solid ${complete ? T.green : T.amber}55`, borderRadius: "4px", padding: "3px 7px" }}>
                {complete ? "COMPLETED · DIAGNOSTIC" : "INCOMPLETE"}
              </span>
            </div>

            {complete && (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))", gap: "8px", marginTop: "13px" }}>
                  {[
                    ["Dates", String(summary?.coverage?.evaluatedDates ?? aggregate?.n ?? 0)],
                    ["Median names", String(summary?.coverage?.medianCrossSection ?? "Unavailable")],
                    ["Mean IC", number(aggregate?.meanIc)],
                    ["IC sigma", number(aggregate?.sigmaIc)],
                    ["IC IR", number(aggregate?.icIr)],
                    ["HAC t", number(aggregate?.tHac, 2)],
                  ].map(([label, value]) => (
                    <div key={label} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "6px", padding: "8px 10px", minWidth: 0 }}>
                      <div style={{ fontSize: "9px", color: T.muted, textTransform: "uppercase" }}>{label}</div>
                      <div style={{ fontSize: "14px", color: label === "Mean IC" && aggregate?.meanIc != null ? (aggregate.meanIc > 0 ? T.green : T.red) : T.text, fontWeight: 700, marginTop: "2px", overflowWrap: "anywhere" }}>{value}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: "10px", color: T.muted, marginTop: "10px", overflowWrap: "anywhere" }}>
                  Dataset {run.dataset_fingerprint?.slice(0, 12) ?? "Unavailable"} · Code {run.code_version.slice(0, 8)} · Run {run.run_fingerprint?.slice(0, 12) ?? "Unavailable"}
                </div>
                {summary?.limitations?.length ? (
                  <div style={{ fontSize: "11px", color: T.sub, marginTop: "8px" }}>{summary.limitations[0]}</div>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
