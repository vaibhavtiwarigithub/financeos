"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = {
  surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399",
  red: "#F87171", amber: "#FBBF24",
};

type Version = {
  id: number;
  version: string;
  name: string;
  state: string;
  is_champion: boolean;
  created_at: string;
  promoted_at?: string | null;
  retired_at?: string | null;
  rejection_reason?: string | null;
  validation?: { passed: boolean; p_improvement?: number | null; n_effective?: number | null; fail_reason?: string | null; created_at?: string | null } | null;
  experiment_runs?: Array<{ completed_at?: string | null; status?: string | null; signal_count?: number | null; win_rate?: number | null; avg_return_pct?: number | null; sharpe_ratio?: number | null; max_drawdown_pct?: number | null; alpha_pct?: number | null; gate_pass?: boolean | null }>;
};

const stamp = (value?: string | null) => value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Not recorded";
const pct = (value?: number | null) => value == null ? "Not measured" : `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;

function Metric({ label, value, tone = T.text }: { label: string; value: string; tone?: string }) {
  return <div><div style={{ color: T.muted, fontSize: "10px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</div><div style={{ color: tone, fontSize: "13px", fontWeight: 700, marginTop: "3px" }}>{value}</div></div>;
}

function Evidence({ version }: { version: Version }) {
  const run = [...(version.experiment_runs ?? [])].sort((a, b) =>
    String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? "")),
  )[0];
  if (!run) return <div style={{ color: T.muted, fontSize: "12px", marginTop: "10px" }}>No experiment result has been recorded yet.</div>;
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(104px, 1fr))", gap: "12px", marginTop: "12px", paddingTop: "12px", borderTop: `1px solid ${T.border}` }}>
    <Metric label="Signals" value={run.signal_count == null ? "Not measured" : String(run.signal_count)} />
    <Metric label="Win rate" value={run.win_rate == null ? "Not measured" : `${(run.win_rate * 100).toFixed(0)}%`} tone={run.win_rate != null && run.win_rate >= 0.5 ? T.green : T.text} />
    <Metric label="Average return" value={pct(run.avg_return_pct)} tone={(run.avg_return_pct ?? 0) >= 0 ? T.green : T.red} />
    <Metric label="Sharpe" value={run.sharpe_ratio == null ? "Not measured" : run.sharpe_ratio.toFixed(2)} tone={(run.sharpe_ratio ?? 0) >= 0.5 ? T.green : T.amber} />
    <Metric label="Max drawdown" value={run.max_drawdown_pct == null ? "Not measured" : `${run.max_drawdown_pct.toFixed(1)}%`} tone={T.textSub} />
    <Metric label="Alpha" value={pct(run.alpha_pct)} tone={(run.alpha_pct ?? 0) >= 0 ? T.green : T.red} />
  </div>;
}

export default function StrategyGovernancePanel() {
  const { market } = useMarket();
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    fetch(`/api/strategies/versions?market=${market}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not load strategy governance.");
        if (!cancelled) setVersions(body.versions ?? []);
      })
      .catch((cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load strategy governance."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [market]);

  const champion = versions.find((version) => version.is_champion) ?? null;
  const historicChampions = versions.filter((version) => !version.is_champion && version.promoted_at);
  const challengers = versions.filter((version) => !version.is_champion && !version.promoted_at);
  const marketLabel = market === "india" ? "India" : "US";

  return <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "20px", marginBottom: "24px" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: "16px", alignItems: "flex-start", flexWrap: "wrap" }}>
      <div><div style={{ color: T.text, fontSize: "16px", fontWeight: 700 }}>Active strategy and challengers</div><div style={{ color: T.textSub, fontSize: "12px", marginTop: "4px" }}>{marketLabel}-only. Learner proposals continue automatically; a challenger never changes the active strategy by itself.</div></div>
      <div style={{ color: T.muted, fontSize: "12px" }}>{loading ? "Loading…" : `${challengers.length} challenger${challengers.length === 1 ? "" : "s"}`}</div>
    </div>
    {error ? <div style={{ color: T.red, fontSize: "12px", marginTop: "16px" }}>{error}</div> : loading ? <div style={{ color: T.muted, fontSize: "13px", padding: "20px 0" }}>Loading governed strategy evidence…</div> : <>
      <div style={{ background: T.surface, border: `1px solid ${champion ? T.accent + "66" : T.border}`, borderRadius: "8px", padding: "16px", marginTop: "16px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}><span style={{ color: champion ? T.accent : T.amber, fontSize: "10px", fontWeight: 800, letterSpacing: "0.08em" }}>{champion ? "CURRENT CHAMPION" : "CURRENT BASELINE"}</span><span style={{ color: T.text, fontSize: "14px", fontWeight: 700 }}>{champion ? `${champion.name} · v${champion.version}` : "Risk-profile default weights"}</span></div>
        <div style={{ color: T.textSub, fontSize: "12px", marginTop: "7px" }}>{champion ? `Promoted ${stamp(champion.promoted_at)}. These are the only learned strategy settings currently allowed to affect this market.` : "No learned version is active for this market. Scoring uses the market's configured default weights."}</div>
        {champion && <Evidence version={champion} />}
      </div>
      <div style={{ marginTop: "18px", color: T.muted, fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em" }}>CHALLENGERS</div>
      {challengers.length === 0 ? <div style={{ color: T.muted, fontSize: "13px", padding: "12px 0" }}>No challenger is waiting. Learning still records outcomes and can propose the next one when evidence supports a change.</div> : challengers.map((version) => <div key={version.id} style={{ borderBottom: `1px solid ${T.border}`, padding: "14px 0" }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}><div><span style={{ color: T.text, fontWeight: 700, fontSize: "13px" }}>{version.name} · v{version.version}</span><span style={{ color: T.muted, fontSize: "11px", marginLeft: "8px" }}>Created {stamp(version.created_at)}</span></div><span style={{ color: version.validation?.passed ? T.green : T.amber, fontSize: "11px", fontWeight: 700 }}>{version.validation?.passed ? "Validation passed" : version.validation ? "Validation did not pass" : "Awaiting validation"}</span></div>
        {version.validation && <div style={{ color: version.validation.passed ? T.green : T.textSub, fontSize: "12px", marginTop: "7px" }}>{version.validation.passed ? `Validated with n=${version.validation.n_effective ?? "not recorded"}; promotion remains a protected action.` : version.validation.fail_reason ?? "The validation gate did not pass."}</div>}
        <Evidence version={version} />
      </div>)}
      <div style={{ marginTop: "18px", color: T.muted, fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em" }}>PRIOR CHAMPIONS</div>
      {historicChampions.length === 0 ? <div style={{ color: T.muted, fontSize: "13px", paddingTop: "12px" }}>No previous champion exists for this market.</div> : historicChampions.map((version) => <div key={version.id} style={{ borderBottom: `1px solid ${T.border}`, padding: "12px 0", color: T.textSub, fontSize: "12px" }}>{version.name} · v{version.version} · promoted {stamp(version.promoted_at)}{version.retired_at ? ` · retired ${stamp(version.retired_at)}` : ""}</div>)}
    </>}
  </section>;
}
