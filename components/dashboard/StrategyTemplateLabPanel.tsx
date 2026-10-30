"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", amber: "#FBBF24", red: "#F87171", green: "#34D399", blue: "#93C5FD" };
type Metric = { matured: number; wins: number; hitRatePct: number | null; meanNetReturnPct: number | null };
type Evidence = {
  state: string; decisionCount: number; displayedDecisionWindow: number; maturedCount: number; pendingCount: number;
  ruleSelected: Metric; deterministicEligible: Metric; latestBacktest: any; latestEvent: any;
  overlap: Record<string, Metric>;
};
type Config = { id: string; kind: string; state: string; template_ids: string[]; rule_version: string; trial_family_id: string; config_fingerprint: string; created_at: string; rule_spec: any; evidence: Evidence };
type Template = { id: string; name: string; description: string; rules: Record<string, unknown>; supported: boolean; unsupportedReasons: string[] };
type ReadState = { status: "ready" | "not_deployed" | "error"; configs: Config[]; templates: Template[]; limits?: { maxActive: number; used: number; maxUniverseSymbols: number }; message?: string };

function fmt(value: unknown, digits = 2) { return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(digits)}%` : "—"; }
function metricLine(label: string, metric?: Metric) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 10, color: T.sub, fontSize: 11, padding: "4px 0" }}><span>{label}</span><span>{metric?.matured ?? 0} labeled · hit {fmt(metric?.hitRatePct)} · mean net {fmt(metric?.meanNetReturnPct)}</span></div>;
}

export default function StrategyTemplateLabPanel() {
  const { market } = useMarket();
  const [state, setState] = useState<ReadState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [templateId, setTemplateId] = useState("");
  const [symbols, setSymbols] = useState(market === "india" ? "NIFTYBEES.NS, RELIANCE.NS, HDFCBANK.NS" : "VOO, QQQ, NVDA");
  const [horizon, setHorizon] = useState(10);
  const [message, setMessage] = useState("");
  const templates = state?.templates ?? [];
  const supportedTemplates = useMemo(() => templates.filter((item) => item.supported), [templates]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/strategies/template-shadows?market=${market}`, { cache: "no-store" });
      const body = await response.json();
      if (body.status === "not_deployed") setState({ status: "not_deployed", configs: [], templates: [], message: "The strategy-shadow ledger is not deployed. No rule decisions or outcomes are being collected." });
      else if (response.ok && body.status === "ready") {
        const options = Array.isArray(body.templates) ? body.templates : [];
        setState({ status: "ready", configs: Array.isArray(body.configs) ? body.configs : [], templates: options, limits: body.limits });
        setTemplateId((current) => current && options.some((item: Template) => item.id === current && item.supported) ? current : options.find((item: Template) => item.supported)?.id ?? "");
      } else setState({ status: "error", configs: [], templates: [], message: "Strategy lab status could not be read. Retry; this is not evidence the queue is empty." });
    } catch { setState({ status: "error", configs: [], templates: [], message: "Strategy lab status could not be read. Check connection and retry; this is not evidence the queue is empty." }); }
    finally { setLoading(false); }
  }, [market, attempt]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setSymbols(market === "india" ? "NIFTYBEES.NS, RELIANCE.NS, HDFCBANK.NS" : "VOO, QQQ, NVDA"); }, [market]);

  const statusColor = state?.status === "ready" ? T.green : state?.status === "error" ? T.red : T.amber;
  async function createShadow() {
    setBusy(true); setMessage("");
    try {
      const universe = [...new Set(symbols.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
      const response = await fetch("/api/strategies/template-shadows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ market, template_id: templateId, universe, horizon_sessions: horizon }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.details?.join("; ") || body.detail || body.error || "Could not register this rule.");
      setMessage(`Frozen ${body.compilerVersion} configuration registered as a draft. Review the holdout below; forward collection starts only after the explicit Start shadow action.`);
      await load();
    } catch (error: any) { setMessage(String(error?.message ?? error)); }
    finally { setBusy(false); }
  }
  async function runPatternScan() {
    setBusy(true); setMessage("");
    try {
      const universe = [...new Set(symbols.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
      const response = await fetch("/api/strategies/template-shadows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "scan", market, universe, horizon_sessions: horizon }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || body.error || "Predeclared pattern scan failed.");
      const names = (body.configs ?? []).map((row: any) => row.config?.rule_spec?.label ?? row.name ?? "pattern").join(", ");
      setMessage(`Scanned supported, frozen price patterns and registered ${body.configs?.length ?? 0} draft configuration(s): ${names}. Open each holdout result and explicitly start any forward shadow.`);
      await load();
    } catch (error: any) { setMessage(String(error?.message ?? error)); }
    finally { setBusy(false); }
  }
  async function transition(configId: string, event: string, reason: string) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/strategies/template-shadows", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ config_id: configId, event, reason }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.detail || body.error || "Lifecycle action failed.");
      setMessage(event === "shadow" || event === "resumed" ? "Forward shadow started. Research will append decisions during its normal market-local runs; there is no extra schedule or model call." : `Configuration ${event}.`);
      await load();
    } catch (error: any) { setMessage(String(error?.message ?? error)); }
    finally { setBusy(false); }
  }

  return <section aria-labelledby="strategy-template-lab-title" style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: 20, marginBottom: 24 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
      <div>
        <h3 id="strategy-template-lab-title" style={{ color: T.text, fontSize: 16, margin: 0 }}>Strategy discovery & forward tournament · {market === "india" ? "India" : "US"}</h3>
        <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.6, margin: "6px 0 0", maxWidth: 900 }}>A frozen deterministic rule is backtested on point-in-time-available cached bars, then compared with the current entry screen on the same future symbol sessions. It is research-only: no score, position, paper fill, live proposal, or order can consume this result.</p>
      </div>
      <button type="button" onClick={() => setAttempt((value) => value + 1)} disabled={loading} style={{ color: T.sub, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 10px", cursor: loading ? "wait" : "pointer", fontSize: 12 }}>{loading ? "Checking…" : "Refresh"}</button>
    </div>
    {!state ? <p style={{ color: T.muted, fontSize: 12, marginTop: 14 }}>Checking whether the strategy producer is deployed…</p> : <>
      <div role="status" style={{ marginTop: 14, padding: 12, background: T.surface, border: `1px solid ${statusColor}55`, borderRadius: 6, color: statusColor, fontSize: 12, lineHeight: 1.6 }}>
        <strong>{state.status === "ready" ? "Research-only producer ready" : state.status === "not_deployed" ? "Not collecting yet" : "Status unavailable"}</strong>{state.message ? ` — ${state.message}` : state.status === "ready" ? ` — ${state.limits?.used ?? state.configs.filter((row) => row.state !== "retired").length}/${state.limits?.maxActive ?? 3} active or draft configuration slots used for this market.` : ""}
      </div>
      {state.status === "ready" && <>
        <div style={{ marginTop: 14, padding: 14, background: T.surface, border: `1px solid ${T.border}`, borderRadius: 7 }}>
          <div style={{ color: T.text, fontWeight: 650, fontSize: 13 }}>Register a predeclared strategy hypothesis</div>
          <p style={{ color: T.muted, fontSize: 11, lineHeight: 1.5, margin: "5px 0 10px" }}>Only complete price-based templates supported by the deterministic grammar can run. Unsupported fundamental, sentiment, or insider clauses remain visible in the list but cannot be stripped or approximated.</p>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 1fr) minmax(180px, 1.5fr) 110px auto", gap: 8, alignItems: "end" }}>
            <label style={{ color: T.sub, fontSize: 11 }}>Price rule<select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={fieldStyle}>
              {templates.map((item) => <option key={item.id} value={item.id} disabled={!item.supported}>{item.name}{item.supported ? "" : " · unavailable inputs"}</option>)}
            </select></label>
            <label style={{ color: T.sub, fontSize: 11 }}>Frozen symbols (max {state.limits?.maxUniverseSymbols ?? 10})<input value={symbols} onChange={(e) => setSymbols(e.target.value)} style={fieldStyle} placeholder="VOO, QQQ, NVDA" /></label>
            <label style={{ color: T.sub, fontSize: 11 }}>Exit horizon<select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={fieldStyle}>{[2,5,10,20].map((value) => <option value={value} key={value}>{value} sessions</option>)}</select></label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              <button type="button" disabled={busy || !templateId || (state.limits?.used ?? state.configs.length) >= (state.limits?.maxActive ?? 3)} onClick={() => void createShadow()} style={actionStyle(busy || !templateId || (state.limits?.used ?? state.configs.length) >= (state.limits?.maxActive ?? 3))}>{busy ? "Working…" : "Backtest selected"}</button>
              <button type="button" disabled={busy || (state.limits?.used ?? state.configs.length) >= (state.limits?.maxActive ?? 3)} onClick={() => void runPatternScan()} style={{ ...actionStyle(busy || (state.limits?.used ?? state.configs.length) >= (state.limits?.maxActive ?? 3)), background: busy ? T.surface : "#065F46" }}>{busy ? "Scanning…" : "Scan fixed patterns"}</button>
            </div>
          </div>
          <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.45, margin: "8px 0 0" }}>“Scan fixed patterns” tests only the currently supported, predeclared daily-price rules (no generated search space) and uses one of at most three market-local slots per candidate. Run reads up to 750 verified cached daily bars per symbol. History is survivorship-selected and may be adjusted retrospectively; this is a screening diagnostic, not promotion-grade proof. Trial universe and horizon are frozen in the fingerprint.</p>
        </div>
        {message && <p role="status" style={{ color: message.toLowerCase().includes("failed") || message.toLowerCase().includes("could not") ? T.red : T.blue, fontSize: 11, lineHeight: 1.5 }}>{message}</p>}
        {templates.some((item) => !item.supported) && <details style={{ marginTop: 8, color: T.muted, fontSize: 11 }}><summary style={{ cursor: "pointer" }}>Why other library rules are unavailable</summary><ul>{templates.filter((item) => !item.supported).map((item) => <li key={item.id} style={{ marginTop: 5 }}><strong>{item.name}:</strong> {item.unsupportedReasons.join("; ")}</li>)}</ul></details>}
        {state.configs.length > 0 ? <div style={{ marginTop: 14 }}>
          {state.configs.map((config) => {
            const backtest = config.evidence?.latestBacktest;
            const holdout = backtest?.holdout;
            const canStart = backtest?.status === "diagnostic_only" && holdout?.sessions >= 30 && holdout?.trades >= 1 && holdout?.unpricedSessions === 0 && holdout?.benchmarkMissingSessions === 0 && holdout?.excessReturnPp != null;
            const activeCount = state.configs.filter((row) => row.state === "shadow").length;
            const canActivate = (config.state === "draft" || config.state === "validating" || config.state === "paused") && canStart && activeCount < (state.limits?.maxActive ?? 3);
            return <article key={config.id} style={{ borderTop: `1px solid ${T.border}`, padding: "14px 0 10px", marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
                <div><div style={{ color: T.text, fontWeight: 650, fontSize: 13 }}>{config.rule_spec?.label ?? "Frozen strategy"} · <span style={{ color: config.state === "shadow" ? T.green : T.amber }}>{config.state}</span></div><div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>{config.rule_version} · {config.rule_spec?.universe?.join(", ")} · {config.rule_spec?.horizonSessions} sessions · registered {new Date(config.created_at).toLocaleDateString()}</div></div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {canActivate && <button type="button" disabled={busy} onClick={() => void transition(config.id, config.state === "paused" ? "resumed" : "shadow", "owner_started_bounded_forward_shadow")} style={actionStyle(busy)}>Start forward shadow</button>}
                  {config.state === "shadow" && <button type="button" disabled={busy} onClick={() => void transition(config.id, "paused", "owner_paused_forward_shadow")} style={actionStyle(busy)}>Pause</button>}
                  {!(["retired"].includes(config.state)) && <button type="button" disabled={busy} onClick={() => void transition(config.id, "retired", "owner_retired_bounded_forward_shadow")} style={{ ...actionStyle(busy), color: T.sub }}>Retire</button>}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 10 }}>
                <MetricCard label="Historical holdout" value={holdout ? `${holdout.sessions} sessions` : "Insufficient data"} sub={holdout ? `${holdout.trades} entries · ${holdout.unpricedSessions} unpriced days · ${holdout.benchmarkMissingSessions} benchmark gaps` : backtest?.limitation ?? "No qualified replay"} />
                <MetricCard label="Net return vs benchmark" value={holdout ? `${fmt(holdout.returnPct)} vs ${fmt(holdout.benchmarkReturnPct)}` : "—"} sub={`Excess ${fmt(holdout?.excessReturnPp, 2)} · drawdown ${fmt(holdout?.maxDrawdownPct, 2)}`} />
                <MetricCard label="Forward labels" value={`${config.evidence?.maturedCount ?? 0} / ${config.evidence?.displayedDecisionWindow ?? 0}`} sub={`${config.evidence?.pendingCount ?? 0} pending in window · ${config.evidence?.decisionCount ?? 0} total decisions`} />
                <MetricCard label="Trial family" value={config.trial_family_id} sub={`fingerprint ${config.config_fingerprint.slice(0, 12)}…`} />
              </div>
              <div style={{ marginTop: 8, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px" }}>
                <div style={{ color: T.text, fontSize: 11, fontWeight: 600, marginBottom: 4 }}>Same-session forward outcome groups · descriptive only</div>
                {metricLine("Rule would enter", config.evidence?.ruleSelected)}
                {metricLine("Existing deterministic screen passes", config.evidence?.deterministicEligible)}
                {Object.entries(config.evidence?.overlap ?? {}).map(([key, metric]) => metricLine(key, metric as Metric))}
                {holdout?.scenarios?.length > 0 && <details style={{ marginTop: 6, color: T.sub, fontSize: 10 }}><summary style={{ cursor: "pointer" }}>Historical holdout by benchmark regime</summary><div style={{ overflowX: "auto", marginTop: 5 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}><thead><tr>{["Regime method", "State", "Sessions", "Rule return", "Benchmark", "Excess"].map((label) => <th key={label} style={{ textAlign: "left", color: T.muted, padding: 4, borderBottom: `1px solid ${T.border}` }}>{label}</th>)}</tr></thead><tbody>{holdout.scenarios.map((row: any) => <tr key={`${row.classifier}-${row.regime}`}><td style={{ padding: 4 }}>{row.classifier}</td><td style={{ padding: 4 }}>{row.regime}</td><td style={{ padding: 4 }}>{row.sessions}</td><td style={{ padding: 4 }}>{fmt(row.strategyCumulativeReturnPct)}</td><td style={{ padding: 4 }}>{fmt(row.benchmarkCumulativeReturnPct)}</td><td style={{ padding: 4 }}>{fmt(row.excessReturnPp)}</td></tr>)}</tbody></table></div><div style={{ color: T.muted, marginTop: 4 }}>These are benchmark trend and realized-volatility price proxies, not economic macro regimes. Volatility cutoffs come from the 70% training window; each state is known at the prior close. Cells are descriptive and overlapping scenario tests are not independent.</div></details>}
                <div style={{ color: T.muted, fontSize: 10, lineHeight: 1.45, marginTop: 4 }}>Outcome labels use next-session open through the frozen horizon, with the existing modeled entry and exit costs. This screen compares sampled research symbols only; it is not a full-book return or evidence the rule caused the move.</div>
              </div>
              {!canStart && (config.state === "draft" || config.state === "validating" || config.state === "paused") && <div style={{ color: T.amber, fontSize: 10, marginTop: 6 }}>Shadow start is gated: the historical test must have a priced 30-session holdout, at least one entry, and a benchmark comparison. No positive return is required.</div>}
            </article>;
          })}
        </div> : <p style={{ color: T.muted, fontSize: 12, marginTop: 12 }}>No frozen strategy hypothesis is registered for this market yet.</p>}
        <p style={{ color: T.muted, fontSize: 10, lineHeight: 1.45, marginTop: 12 }}>A natural research run appends at most one decision per configuration/symbol/session. Mature outcomes stay separate from dimension, council, and trading ledgers. Small samples remain descriptive; there is no automatic strategy selection or promotion.</p>
      </>}
    </>}
  </section>;
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: 9, minWidth: 0 }}><div style={{ color: T.muted, fontSize: 10 }}>{label}</div><div style={{ color: T.text, fontWeight: 650, fontSize: 12, marginTop: 4, overflowWrap: "anywhere" }}>{value}</div><div style={{ color: T.sub, fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>{sub}</div></div>;
}

const fieldStyle = { display: "block", boxSizing: "border-box" as const, width: "100%", marginTop: 4, color: T.text, background: "#0D0F15", border: `1px solid ${T.border}`, borderRadius: 5, padding: "8px", fontSize: 11 };
const actionStyle = (disabled: boolean) => ({ color: T.text, background: disabled ? T.surface : "#1D4ED8", border: `1px solid ${T.border}`, borderRadius: 5, padding: "8px 10px", cursor: disabled ? "not-allowed" as const : "pointer" as const, fontSize: 11, opacity: disabled ? 0.55 : 1, whiteSpace: "nowrap" as const });
