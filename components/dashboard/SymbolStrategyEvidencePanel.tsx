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

type SoxlReplayState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; replay: any };

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
  const [soxlReplay, setSoxlReplay] = useState<SoxlReplayState>({ status: "idle" });

  async function runSoxlDiagnostic() {
    setSoxlReplay({ status: "loading" });
    try {
      const response = await fetch("/api/strategies/template-shadows?action=soxl-reference", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? `Replay failed (${response.status})`);
      setSoxlReplay({ status: "ready", replay: body.replay });
    } catch (error) {
      setSoxlReplay({ status: "error", message: String((error as Error)?.message ?? "Replay unavailable") });
    }
  }

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

    {data.status === "ready" && market === "us" && data.discovery?.workload_metrics?.discovery?.soxlReference && <div style={{ marginTop: 14, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
      <strong style={{ color: T.text, fontSize: 12 }}>Latest automatic SOXL reference cycle</strong>
      {(() => { const result = data.discovery.workload_metrics.discovery.soxlReference; return <>
        <p style={{ color: T.sub, fontSize: 11, lineHeight: 1.6, margin: "6px 0 0" }}>
          {result.status} · as of {result.asOf ?? date(data.discovery.started_at)} · {result.declaredVariants ?? 0} declared variants including the baseline · trial family total {result.familyTrialCount ?? "unavailable"}.
          {result.detail ? ` ${result.detail}` : " Results are research diagnostics only; they do not flow into score, paper-selection, or live-trading paths."}
          {result.limitations?.length ? ` ${result.limitations.join(" ")}` : ""}
        </p>
        {result.summary && <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 8, margin: "10px 0" }}>
          <Metric label="Reference trades" value={String(result.summary.trades)} />
          <Metric label="Reference win rate" value={result.summary.winRatePct == null ? "—" : `${result.summary.winRatePct.toFixed(1)}%`} />
          <Metric label="Reference trade-sequence return" value={result.summary.compoundedReturnPct == null ? "—" : `${result.summary.compoundedReturnPct >= 0 ? "+" : ""}${result.summary.compoundedReturnPct.toFixed(2)}%`} />
          <Metric label="50 bps/side stress sequence" value={result.stress?.summary?.compoundedReturnPct == null ? "—" : `${result.stress.summary.compoundedReturnPct >= 0 ? "+" : ""}${result.stress.summary.compoundedReturnPct.toFixed(2)}%`} />
        </dl>}
        {result.periods?.length > 0 && <p style={{ color: T.muted, fontSize: 10, margin: "7px 0" }}>{result.periods.map((period: any) => `${period.name}: ${period.summary?.trades ?? 0} trades / ${period.summary?.winRatePct == null ? "—" : `${period.summary.winRatePct.toFixed(1)}% win`} / ${period.summary?.compoundedReturnPct == null ? "—" : `${period.summary.compoundedReturnPct >= 0 ? "+" : ""}${period.summary.compoundedReturnPct.toFixed(2)}%`}`).join(" · ")} · both periods were previously inspected, not independent tests.</p>}
        {result.factorScenarios?.length > 0 && <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.5, margin: "7px 0" }}>VIX factors: {result.factorScenarios.map((scenario: any) => `${scenario.name}: ${scenario.trades} trades, ${scenario.summary?.winRatePct == null ? "—" : `${scenario.summary.winRatePct.toFixed(1)}% wins`}, ${scenario.summary?.compoundedReturnPct == null ? "—" : `${scenario.summary.compoundedReturnPct >= 0 ? "+" : ""}${scenario.summary.compoundedReturnPct.toFixed(2)}%`}`).join(" · ")}</p>}
      </>; })()}
    </div>}

    {market === "us" && symbol === "SOXL" && <div style={{ marginTop: 16, borderTop: `1px solid ${T.border}`, paddingTop: 14 }}>
      <h3 style={{ color: T.text, fontSize: 14, margin: 0 }}>QI Quant SOXX → SOXL reference replay</h3>
      <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6, margin: "6px 0 10px" }}>
        Fixed research hypothesis: SOXX above its 200-day average with Wilder RSI(14) below 35; enter SOXL at the next open, with 6% stop, 25% target and a 15-session time exit. VIX is provenance-checked and available as a declared filter, but is not assumed to improve this strategy. This read-only diagnostic uses only aligned, consistently sourced cached bars. Historical selection makes it non-independent; it cannot affect research scores or trading.
      </p>
      <button type="button" onClick={runSoxlDiagnostic} disabled={soxlReplay.status === "loading"}
        style={{ background: T.accent, border: 0, borderRadius: 6, color: "#10121A", cursor: soxlReplay.status === "loading" ? "wait" : "pointer", fontWeight: 700, padding: "8px 12px" }}>
        {soxlReplay.status === "loading" ? "Checking cached data…" : "Run read-only diagnostic"}
      </button>
      {soxlReplay.status === "error" && <p role="alert" style={{ color: T.red, fontSize: 12 }}>{soxlReplay.message}</p>}
      {soxlReplay.status === "ready" && <div style={{ marginTop: 12, border: `1px solid ${T.border}`, borderRadius: 8, padding: 12 }}>
        <strong style={{ color: soxlReplay.replay.status === "diagnostic_only" ? T.amber : T.red, fontSize: 12 }}>
          {soxlReplay.replay.status === "diagnostic_only" ? "Descriptive historical diagnostic — not validated" : "Insufficient data — no performance claim calculated"}
        </strong>
        <p style={{ color: T.sub, fontSize: 11, lineHeight: 1.6, margin: "7px 0" }}>
          {soxlReplay.replay.data?.sessions ?? 0} aligned sessions · {soxlReplay.replay.data?.from ?? "—"} to {soxlReplay.replay.data?.through ?? "—"} · sources: {Object.entries(soxlReplay.replay.data?.provenance ?? {}).map(([name, value]: [string, any]) => `${name}=${value.provider ?? "missing"}/${value.priceBasis ?? "unknown"}/${value.provenanceVersion ?? "unknown"}`).join("; ")}
        </p>
        {soxlReplay.replay.summary && <dl style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(125px,1fr))", gap: 8, margin: "10px 0" }}>
          <Metric label="Trades" value={String(soxlReplay.replay.summary.trades)} />
          <Metric label="Wins" value={soxlReplay.replay.summary.winRatePct == null ? "—" : `${soxlReplay.replay.summary.wins}/${soxlReplay.replay.summary.trades} · ${soxlReplay.replay.summary.winRatePct.toFixed(1)}%`} />
          <Metric label="Profit factor" value={soxlReplay.replay.summary.profitFactor == null ? "Not estimable" : soxlReplay.replay.summary.profitFactor.toFixed(2)} />
          <Metric label="Trade-sequence compounded return" value={soxlReplay.replay.summary.compoundedReturnPct == null ? "—" : `${soxlReplay.replay.summary.compoundedReturnPct >= 0 ? "+" : ""}${soxlReplay.replay.summary.compoundedReturnPct.toFixed(2)}%`} />
          <Metric label="Trade-sequence max drawdown" value={`${soxlReplay.replay.summary.maxDrawdownPct.toFixed(2)}%`} />
          <Metric label="Stress-cost return" value={soxlReplay.replay.stress.summary?.compoundedReturnPct == null ? "—" : `${soxlReplay.replay.stress.summary.compoundedReturnPct >= 0 ? "+" : ""}${soxlReplay.replay.stress.summary.compoundedReturnPct.toFixed(2)}%`} />
        </dl>}
        {soxlReplay.replay.periods?.length > 0 && <>
          <strong style={{ color: T.text, fontSize: 11 }}>Previously inspected calendar periods (neither is an untouched holdout)</strong>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 8, marginTop: 7 }}>
            {soxlReplay.replay.periods.map((period: any) => <div key={period.name} style={{ border: `1px solid ${T.border}`, borderRadius: 6, padding: 9, color: T.sub, fontSize: 11 }}>
              <b style={{ color: T.text }}>{period.name}</b> · {period.summary.trades} trades · {period.summary.winRatePct == null ? "—" : `${period.summary.winRatePct.toFixed(1)}% wins`} · {period.summary.compoundedReturnPct == null ? "—" : `${period.summary.compoundedReturnPct >= 0 ? "+" : ""}${period.summary.compoundedReturnPct.toFixed(2)}% net`}
            </div>)}
          </div>
        </>}
        {soxlReplay.replay.factorScenarios?.length > 0 && <div style={{ marginTop: 10 }}>
          <strong style={{ color: T.text, fontSize: 11 }}>Predeclared VIX factor comparisons · all counted as trials</strong>
          <div style={{ overflowX: "auto", marginTop: 6 }}><table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, color: T.sub }}>
            <thead><tr>{["Filter", "Trades", "Win rate", "Net return"].map((label) => <th key={label} style={{ textAlign: "left", padding: 6, borderBottom: `1px solid ${T.border}`, color: T.muted }}>{label}</th>)}</tr></thead>
            <tbody>{soxlReplay.replay.factorScenarios.map((row: any) => <tr key={row.name}>
              <td style={{ padding: 6 }}>{row.name}</td><td style={{ padding: 6 }}>{row.trades}</td>
              <td style={{ padding: 6 }}>{row.summary.winRatePct == null ? "—" : `${row.summary.winRatePct.toFixed(1)}%`}</td>
              <td style={{ padding: 6 }}>{row.summary.compoundedReturnPct == null ? "—" : `${row.summary.compoundedReturnPct >= 0 ? "+" : ""}${row.summary.compoundedReturnPct.toFixed(2)}%`}</td>
            </tr>)}</tbody>
          </table></div>
        </div>}
        {soxlReplay.replay.trades?.length > 0 && <details style={{ marginTop: 10 }}>
          <summary style={{ color: T.text, cursor: "pointer", fontSize: 11 }}>Replay trade ledger ({soxlReplay.replay.trades.length})</summary>
          <div style={{ overflowX: "auto", marginTop: 6 }}><table style={{ borderCollapse: "collapse", width: "100%", fontSize: 10, color: T.sub }}>
            <thead><tr>{["Signal date", "Entry", "Entry price", "Exit", "Net exit", "Net return", "Sessions", "Exit reason"].map((label) => <th key={label} style={{ textAlign: "left", padding: 5, borderBottom: `1px solid ${T.border}`, color: T.muted }}>{label}</th>)}</tr></thead>
            <tbody>{soxlReplay.replay.trades.map((trade: any, index: number) => <tr key={`${trade.signalSession}-${index}`}>
              <td style={{ padding: 5 }}>{trade.signalSession}</td><td style={{ padding: 5 }}>{trade.entrySession}</td><td style={{ padding: 5 }}>${trade.entryPrice.toFixed(2)}</td>
              <td style={{ padding: 5 }}>{trade.exitSession}</td><td style={{ padding: 5 }}>${trade.exitPrice.toFixed(2)}</td><td style={{ padding: 5 }}>{trade.returnPct >= 0 ? "+" : ""}{trade.returnPct.toFixed(2)}%</td>
              <td style={{ padding: 5 }}>{trade.holdingSessions}</td><td style={{ padding: 5 }}>{trade.exitReason}</td>
            </tr>)}</tbody>
          </table></div>
        </details>}
        <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.55, margin: "8px 0 0" }}>
          Costs: {soxlReplay.replay.assumptions?.costBpsPerSide} bps per side; stop gaps fill at the open, daily stop/target collisions resolve to the stop, and targets receive no favorable gap improvement. {soxlReplay.replay.limitations?.join(" ") || "This is a fixed reference diagnostic on a selection-exposed sample. It is not an untouched holdout, does not establish edge, and is not a trade signal."} {soxlReplay.replay.caveats?.join(" ")}
        </p>
      </div>}
    </div>}
  </section>;
}

function Metric({ label, value, color = T.text }: { label: string; value: string; color?: string }) {
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 7, padding: "9px 10px" }}>
    <dt style={{ color: T.muted, fontSize: 10 }}>{label}</dt>
    <dd style={{ color, fontSize: 13, fontWeight: 700, margin: "4px 0 0" }}>{value}</dd>
  </div>;
}
