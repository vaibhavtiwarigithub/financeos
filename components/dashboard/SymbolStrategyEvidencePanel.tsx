"use client";

import { useEffect, useState } from "react";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280",
  accent: "#818CF8", green: "#34D399", amber: "#FBBF24", red: "#F87171",
};

type Evidence = {
  state: "descriptive_only" | "forward_labels_pending" | "no_symbol_observations";
  decisionCount: number;
  displayedDecisionWindow: number;
  maturedCount: number;
  pendingCount: number;
  ruleSelected: { matured: number; wins: number; hitRatePct: number | null; meanNetReturnPct: number | null };
  deterministicEligible: { matured: number; wins: number; hitRatePct: number | null; meanNetReturnPct: number | null };
  latestBacktest: any;
};

type Config = {
  id: string;
  state: string;
  kind: string;
  template_ids: string[];
  rule_spec: { label?: string; horizonSessions?: number; rules?: Record<string, unknown> };
  rule_version: string;
  created_at: string;
  evidence: Evidence;
};

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; configs: Config[]; discovery: any; selected: any };

function pct(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function date(value?: string | null) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString();
}

function stateText(config: Config) {
  if (config.evidence.maturedCount > 0) return "Forward evidence is descriptive only";
  if (config.evidence.pendingCount > 0) return "Waiting for forward labels";
  if (config.evidence.decisionCount > 0) return "No matured forward labels yet";
  return `No shadow decision recorded for this symbol · shadow ${config.state}`;
}

export default function SymbolStrategyEvidencePanel({ symbol, market }: { symbol: string; market: "us" | "india" }) {
  const [data, setData] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setData({ status: "loading" });
    fetch(`/api/strategies/template-shadows?market=${market}&symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Strategy evidence request failed (${response.status})`);
        if (active) setData({ status: "ready", configs: body.configs ?? [], discovery: body.discovery ?? null, selected: body.paperSelection ?? null });
      })
      .catch((error) => {
        if (active) setData({ status: "error", message: String(error?.message ?? "Strategy evidence is unavailable.") });
      });
    return () => { active = false; };
  }, [market, symbol]);

  return <section aria-labelledby="symbol-strategy-title" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 20 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
      <div>
        <h2 id="symbol-strategy-title" style={{ margin: 0, color: T.text, fontSize: 18 }}>Strategy research for {symbol}</h2>
        <p style={{ margin: "6px 0 0", color: T.sub, fontSize: 12, lineHeight: 1.6 }}>
          Kairos-owned, point-in-time shadow evidence for candidates whose declared universe includes this symbol. This panel cannot place or recommend an order.
        </p>
      </div>
      <span style={{ color: T.accent, fontSize: 11, fontWeight: 700 }}>SHADOW ONLY</span>
    </div>

    {data.status === "loading" && <p role="status" style={{ color: T.muted, fontSize: 13 }}>Loading recorded strategy evidence…</p>}
    {data.status === "error" && <p role="alert" style={{ color: T.red, fontSize: 13 }}>Could not load strategy evidence: {data.message}</p>}
    {data.status === "ready" && data.configs.length === 0 && <div style={{ marginTop: 16, border: `1px solid ${T.border}`, borderRadius: 8, padding: 14 }}>
      <strong style={{ color: T.amber, fontSize: 13 }}>No applicable strategy shadow is recorded for {symbol}.</strong>
      <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6, margin: "7px 0 0" }}>
        This means Kairos has no candidate configuration whose frozen research universe contains this symbol. It is not a zero score, a failed backtest, or evidence that no strategy could work. The market discovery loop is bounded and only screens its eligible researched-symbol cohort; it does not run a separate LLM backtest for every ticker.
      </p>
      {data.discovery?.started_at && <p style={{ color: T.muted, fontSize: 11, margin: "8px 0 0" }}>
        Latest recorded discovery cycle: {date(data.discovery.started_at)} · {data.discovery.status}{data.discovery.result_summary ? ` · ${data.discovery.result_summary}` : ""}
      </p>}
      {data.discovery == null && <p style={{ color: T.muted, fontSize: 11, margin: "8px 0 0" }}>
        No autonomous strategy-discovery run is recorded yet. The next natural weekly Learner cycle should populate the attempt ledger; this view does not trigger a run.
      </p>}
    </div>}

    {data.status === "ready" && data.configs.length > 0 && <div style={{ display: "grid", gap: 12, marginTop: 16 }}>
      {data.configs.map((config) => {
        const selected = data.selected?.config_id === config.id;
        const hasMatured = config.evidence.maturedCount > 0;
        return <article key={config.id} style={{ border: `1px solid ${T.border}`, borderRadius: 9, padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div>
              <h3 style={{ color: T.text, fontSize: 14, margin: 0 }}>{config.rule_spec?.label ?? `${config.kind} strategy candidate`}</h3>
              <div style={{ color: T.muted, fontSize: 11, marginTop: 5 }}>Version {config.rule_version} · {config.rule_spec?.horizonSessions ?? "?"} session horizon · registered {date(config.created_at)}{selected ? " · paper ranking preference" : ""}</div>
            </div>
            <span style={{ color: hasMatured ? T.amber : T.muted, fontSize: 11, fontWeight: 700 }}>{stateText(config)}</span>
          </div>
          <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10, margin: "14px 0 0" }}>
            <Metric label="Symbol shadow decisions" value={String(config.evidence.decisionCount)} />
            <Metric label="Matured forward labels" value={`${config.evidence.maturedCount} / ${config.evidence.decisionCount}`} />
            <Metric label="Net return · matured only" value={pct(config.evidence.ruleSelected.meanNetReturnPct)} color={config.evidence.ruleSelected.meanNetReturnPct == null ? T.muted : config.evidence.ruleSelected.meanNetReturnPct >= 0 ? T.green : T.red} />
            <Metric label="Positive outcomes · descriptive" value={config.evidence.ruleSelected.hitRatePct == null ? "—" : `${config.evidence.ruleSelected.wins}/${config.evidence.maturedCount} · ${config.evidence.ruleSelected.hitRatePct.toFixed(1)}%`} />
            <Metric label="Baseline eligible · net" value={pct(config.evidence.deterministicEligible.meanNetReturnPct)} />
          </dl>
          <p style={{ color: T.sub, fontSize: 11, lineHeight: 1.6, margin: "12px 0 0" }}>
            {config.evidence.decisionCount === 0
              ? "This symbol is in the candidate's declared universe, but its natural research observations have not produced a shadow decision yet."
              : `${config.evidence.pendingCount} outcomes are still pending. Returns compare this frozen rule with Kairos' deterministic eligibility on the same matured symbol sessions; the small per-symbol sample is descriptive and does not validate the strategy.`}
          </p>
          {config.evidence.latestBacktest && <p style={{ color: T.muted, fontSize: 11, margin: "8px 0 0" }}>
            Candidate-level historical screen: {config.evidence.latestBacktest.status ?? "recorded"} · {config.evidence.latestBacktest.method ?? "fixed replay"}. Historical fit is separate from this symbol's forward observations.
          </p>}
        </article>;
      })}
    </div>}
  </section>;
}

function Metric({ label, value, color = T.text }: { label: string; value: string; color?: string }) {
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 7, padding: "9px 10px" }}>
    <dt style={{ color: T.muted, fontSize: 10 }}>{label}</dt>
    <dd style={{ color, fontSize: 13, fontWeight: 700, margin: "4px 0 0" }}>{value}</dd>
  </div>;
}
