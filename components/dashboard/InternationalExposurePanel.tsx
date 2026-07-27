"use client";

import { useState } from "react";

import { fmtMoney } from "@/lib/format-money";
import {
  summarizeInternationalExposure,
  type PaperPositionExposureInput,
} from "@/lib/allocation/international-exposure";
import type { InternationalAllocationPolicyRead } from "@/lib/allocation/international-policy";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1", amber: "#FBBF24", green: "#34D399",
};

export default function InternationalExposurePanel({
  market,
  positions,
  policy,
}: {
  market: "us" | "india";
  positions: PaperPositionExposureInput[];
  policy: InternationalAllocationPolicyRead | null;
}) {
  if (market !== "us") return null;
  const summary = summarizeInternationalExposure(positions);
  const hasRecognizedExposure = summary.rows.length > 0;

  return (
    <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px", marginBottom: "20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", flexWrap: "wrap", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>US Book Allocation</div>
          <h2 style={{ fontSize: "16px", margin: "5px 0 3px", color: T.text }}>International Equity Exposure</h2>
          <div style={{ fontSize: "12px", color: T.textSub }}>Read-only P1. Source-backed policy observation only; no target or trade is enabled.</div>
        </div>
        <div style={{ border: `1px solid ${T.border}`, borderRadius: "6px", padding: "7px 10px", color: T.muted, fontSize: "11px", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Observe only · no action
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: "10px", marginTop: "16px" }}>
        <Metric label="US paper invested" value={fmtMoney(summary.investedValue, "us", 0)} />
        <Metric
          label="Known fund geography"
          value={summary.recognizedInternationalPct == null ? "—" : `${summary.recognizedInternationalPct.toFixed(1)}%`}
          sub={hasRecognizedExposure ? `${fmtMoney(summary.recognizedInternationalValue, "us", 0)} of valued positions` : "No recognized international fund held"}
          color={hasRecognizedExposure ? T.green : undefined}
        />
        <Metric label="Core construction" value={policy ? `${policy.policy.core_symbol} broad ex-US` : "Source unavailable"} sub={policy ? "Observed only; no target or band set" : "P1 policy record could not be read"} />
      </div>

      {policy?.snapshot ? (
        <div style={{ marginTop: "12px", border: `1px solid ${T.border}`, borderRadius: "6px", padding: "10px", color: T.textSub, fontSize: "12px", lineHeight: 1.45 }}>
          <span style={{ color: T.text, fontWeight: 700 }}>{policy.snapshot.source_name} snapshot</span>
          {" "}· {policy.snapshot.quality} coverage · {policy.snapshot.coverage_pct.toFixed(0)}% mandate scope · country weights unavailable.
          <a href={policy.snapshot.source_url} target="_blank" rel="noreferrer" style={{ color: T.accent, marginLeft: "6px" }}>Source</a>
        </div>
      ) : null}
      {policy?.assessment ? (
        <div style={{ marginTop: "8px", color: T.muted, fontSize: "11px" }}>
          Last assessment: {new Date(policy.assessment.assessed_at).toLocaleString()} · {policy.assessment.observation_kind === "p2_weekly" ? "weekly shadow" : "manual observation"} · {policy.assessment.reason}
        </div>
      ) : null}

      {hasRecognizedExposure ? (
        <div style={{ marginTop: "16px", overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: "440px", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ color: T.muted, textAlign: "left" }}>
                {['Fund', 'Geographic label', 'Paper value', 'US paper book'].map((label) => (
                  <th key={label} style={{ padding: "0 10px 8px 0", fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((row) => (
                <tr key={row.symbol} style={{ borderTop: `1px solid ${T.border}`, color: T.text }}>
                  <td style={{ padding: "9px 10px 9px 0", fontWeight: 700 }}>{row.symbol}</td>
                  <td style={{ padding: "9px 10px 9px 0", color: T.textSub }}>{row.geography}</td>
                  <td style={{ padding: "9px 10px 9px 0" }}>{fmtMoney(row.value, "us", 0)}{row.valuation === "cost" ? <span style={{ color: T.amber, marginLeft: "5px" }} title="No current paper mark; value uses cost.">cost</span> : null}</td>
                  <td style={{ padding: "9px 0" }}>{row.bookPct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ marginTop: "16px", padding: "12px", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.textSub, fontSize: "12px" }}>
          No currently held paper position matches the P0 curated country-ETF map. This is not an instruction to add one.
        </div>
      )}

      {summary.unclassifiedEtfSymbols.length > 0 && (
        <div style={{ marginTop: "10px", color: T.amber, fontSize: "12px" }}>
          Geographic look-through unavailable for held ETF{summary.unclassifiedEtfSymbols.length === 1 ? "" : "s"}: {summary.unclassifiedEtfSymbols.join(", ")}. P0 does not infer their country exposure.
        </div>
      )}
      {summary.costValuedSymbols.length > 0 && (
        <div style={{ marginTop: "8px", color: T.muted, fontSize: "11px" }}>
          Cost fallback used for: {summary.costValuedSymbols.join(", ")}. This panel never fetches a replacement quote.
        </div>
      )}
      <div style={{ marginTop: "12px", color: T.muted, fontSize: "11px", lineHeight: 1.45 }}>
        Scope: current US paper positions only, valued in USD. India/INR holdings, live accounts, company revenue geography, fund holdings, tax lots, and target bands are intentionally not estimated in P0.
      </div>
      <HistoricalReplay policyAvailable={Boolean(policy)} />
    </section>
  );
}

function Metric({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ border: `1px solid ${T.border}`, borderRadius: "6px", padding: "11px" }}>
      <div style={{ fontSize: "10px", color: T.muted, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div>
      <div style={{ marginTop: "4px", color: color ?? T.text, fontWeight: 700, fontSize: "18px" }}>{value}</div>
      {sub ? <div style={{ marginTop: "3px", color: T.textSub, fontSize: "11px", lineHeight: 1.35 }}>{sub}</div> : null}
    </div>
  );
}

type ReplayResult = {
  status: "completed" | "insufficient_history";
  reason?: string;
  startDate: string | null;
  endDate: string | null;
  sessions: number;
  testWeightPct: number;
  oneWayCostBps: number;
  rebalanceCount: number;
  totalCostDragPct: number;
  baseline: { totalReturnPct: number; annualizedReturnPct: number; annualizedVolatilityPct: number; maxDrawdownPct: number } | null;
  testSleeve: { totalReturnPct: number; annualizedReturnPct: number; annualizedVolatilityPct: number; maxDrawdownPct: number } | null;
  excessReturnPct: number | null;
  informationRatio: number | null;
};

function HistoricalReplay({ policyAvailable }: { policyAvailable: boolean }) {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReplayResult | null>(null);

  async function runReplay() {
    setRunning(true);
    setError("");
    try {
      const response = await fetch("/api/allocation/international/replay", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Historical replay could not run");
      setResult(payload.result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Historical replay could not run");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ marginTop: "16px", paddingTop: "14px", borderTop: `1px solid ${T.border}` }}>
      <div style={{ display: "flex", gap: "12px", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <div>
          <div style={{ color: T.text, fontWeight: 700, fontSize: "13px" }}>Historical Allocation Replay</div>
          <div style={{ marginTop: "3px", color: T.textSub, fontSize: "11px", lineHeight: 1.4 }}>Fixed diagnostic only: 100% VOO versus 80% VOO / 20% VXUS, monthly rebalance, 5 bps one-way cost.</div>
        </div>
        <button
          type="button"
          title="Run cache-only historical allocation replay"
          disabled={!policyAvailable || running}
          onClick={runReplay}
          style={{ border: `1px solid ${T.accent}`, background: running ? T.card : "transparent", color: policyAvailable ? T.accent : T.muted, borderRadius: "6px", padding: "7px 10px", fontSize: "12px", fontWeight: 700, cursor: !policyAvailable || running ? "not-allowed" : "pointer" }}
        >
          {running ? "Running replay..." : "Run historical replay"}
        </button>
      </div>
      {error ? <div style={{ marginTop: "9px", color: T.amber, fontSize: "12px" }}>{error}</div> : null}
      {result?.status === "insufficient_history" ? (
        <div style={{ marginTop: "10px", color: T.amber, fontSize: "12px", lineHeight: 1.45 }}>
          {result.reason} The cache backfill is paced through the existing provider budget; no provider call was made by this replay.
        </div>
      ) : null}
      {result?.status === "completed" && result.baseline && result.testSleeve ? (
        <div style={{ marginTop: "12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "8px" }}>
            <Metric label="Matched sessions" value={String(result.sessions)} sub={`${result.startDate} to ${result.endDate}`} />
            <Metric label="VOO return" value={`${result.baseline.totalReturnPct.toFixed(1)}%`} sub={`max drawdown ${result.baseline.maxDrawdownPct.toFixed(1)}%`} />
            <Metric label="Test sleeve return" value={`${result.testSleeve.totalReturnPct.toFixed(1)}%`} sub={`max drawdown ${result.testSleeve.maxDrawdownPct.toFixed(1)}%`} />
            <Metric label="Excess vs VOO" value={`${(result.excessReturnPct ?? 0).toFixed(1)}%`} sub={`information ratio ${result.informationRatio == null ? "unavailable" : result.informationRatio.toFixed(2)}`} color={(result.excessReturnPct ?? 0) >= 0 ? T.green : T.amber} />
          </div>
          <div style={{ marginTop: "8px", color: T.muted, fontSize: "11px", lineHeight: 1.45 }}>
            {result.rebalanceCount} scheduled rebalances; modeled cost drag {result.totalCostDragPct.toFixed(3)}%. This is not a reconstruction of Kairos holdings, a target, a recommendation, or a paper/live execution input.
          </div>
        </div>
      ) : null}
    </div>
  );
}
