"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { COUNCIL_MODELS } from "@/lib/llm-model-catalog";
import { effectiveCouncilDebateRounds } from "@/lib/llm-council/limits";
import { groupCouncilUsageRows, type CouncilUsageRecord } from "@/lib/llm-council/usage-view";
import CouncilSubscriptionWorkers from "./CouncilSubscriptionWorkers";

type CouncilConfig = {
  enabled: boolean;
  execution_mode?: "api" | "subscription";
  subscription_worker_ids?: string[];
  participant_models: string[];
  orchestrator_model: string;
  debate_rounds: number;
  max_symbols_per_market_day: number;
  daily_budget_usd: number;
};
type Run = { id: string; symbol: string; market: string; decision_ts: string; status: string; consensus_score: number | null; consensus_summary: string | null; disagreement_summary: string | null; tokens_in: number; tokens_out: number; cost_usd: number };
type Forecast = { run_id: string; model_requested: string; model_used: string | null; initial_score: number | null; final_score: number | null; confidence: number | null; initial_rationale: string | null; final_rationale: string | null; bull_case: string | null; bear_case: string | null; evidence_citations: Array<{ claim: string; source: string; as_of: string }>; status: string };
type Turn = { run_id: string; model_requested: string; model_used: string | null; turn_role: string; round: number; output_json?: any; output_text?: string | null; tokens_in: number; tokens_out: number; cost_usd: number; status: string };
type IcRow = { market: string; horizon_days: number; series_key: string; forecast_model: string | null; cohort_key: string; observation_count: number; qualifying_sessions: number; independent_windows: number; mean_session_rank_ic: number | null; t_stat: number | null; classification: string; evaluated_at: string };
type Payload = { config: CouncilConfig; providerKeyReadiness: Record<string, boolean>; modelProviders: Record<string, string>; runs: Run[]; forecasts: Forecast[]; turns: Turn[]; ic: IcRow[] };
type UsagePayload = { days: number; asOf: string; rows: CouncilUsageRecord[] };

const MODELS = COUNCIL_MODELS;
const PROVIDER: Record<string, string> = {
  "deepseek-flash": "DeepSeek V4.1 Flash API", "deepseek-v4-pro": "DeepSeek V4 Pro API", "llama-3.3-70b-versatile": "Groq", "llama-3.1-8b-instant": "Groq", "deepseek-r1-distill-llama-70b": "Groq",
  "claude-haiku-4-5": "Anthropic", "claude-sonnet-4-6": "Anthropic", "gemini-2.5-flash": "Google", "gemini-2.5-pro": "Google", "grok-4-fast": "xAI", "grok-4": "xAI",
  "gpt-4o-mini": "OpenAI", "gpt-4o": "OpenAI", "gpt-4.1": "OpenAI", "gpt-5.6-luna": "OpenAI · reasoning: medium", "glm-4.5-air": "Zhipu", "glm-4.6": "Zhipu",
};
const T = { card: "#1A1D27", border: "#252836", surface: "#13151C", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#818cf8", green: "#34D399", red: "#f87171", yellow: "#FBBF24" };

export default function LLMCouncilPanel({ symbol, market }: { symbol?: string; market?: "us" | "india" }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTurns, setShowTurns] = useState(false);
  const [numericDrafts, setNumericDrafts] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [usageDays, setUsageDays] = useState(30);
  const [usageBusy, setUsageBusy] = useState(false);
  const [usageError, setUsageError] = useState("");
  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (symbol) params.set("symbol", symbol);
      if (market) params.set("market", market);
      const query = params.toString();
      const response = await fetch(`/api/agents/llm-council${query ? `?${query}` : ""}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Could not load LLM council");
      setPayload(json);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load LLM council"); }
  }, [symbol, market]);
  useEffect(() => { void load(); }, [load]);

  const loadUsage = useCallback(async (days: number) => {
    setUsageBusy(true);
    setUsageError("");
    try {
      const response = await fetch(`/api/agents/llm-council/usage?days=${days}`, { cache: "no-store" });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Could not load council usage");
      setUsage(json);
    } catch (e) {
      setUsageError(e instanceof Error ? e.message : "Could not load council usage");
    } finally {
      setUsageBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!symbol) void loadUsage(usageDays);
  }, [symbol, usageDays, loadUsage]);

  async function save(patch: Partial<CouncilConfig>) {
    if (!payload) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/agents/llm-council", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload.config, ...patch }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Save failed");
      setPayload({ ...payload, config: json.config, providerKeyReadiness: json.providerKeyReadiness ?? payload.providerKeyReadiness, modelProviders: json.modelProviders ?? payload.modelProviders });
      setNotice("Saved");
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    setBusy(false);
  }

  const latestCells = useMemo(() => {
    const map = new Map<string, IcRow>();
    for (const cell of payload?.ic ?? []) {
      const key = `${cell.market}:${cell.horizon_days}:${cell.cohort_key}:${cell.series_key}`;
      const prior = map.get(key);
      if (!prior || prior.evaluated_at < cell.evaluated_at) map.set(key, cell);
    }
    return [...map.values()].sort((a, b) => a.market.localeCompare(b.market) || a.horizon_days - b.horizon_days || a.series_key.localeCompare(b.series_key));
  }, [payload?.ic]);

  if (error && !payload) return <div style={{ color: T.muted, padding: 12, fontSize: 13 }}>{error}</div>;
  if (!payload) return <div style={{ color: T.muted, padding: 12, fontSize: 13 }}>Loading LLM council…</div>;
  const runs = payload.runs ?? [];
  const current = runs[0];
  const forecasts = payload.forecasts.filter((row) => !current || row.run_id === current.id);
  const turns = symbol ? payload.turns.filter((row) => !current || row.run_id === current.id) : payload.turns;
  const config = payload.config;
  const subscription = config.execution_mode === "subscription";

  const card = { background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 16 };
  const selectStyle = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, padding: "7px 9px", color: T.text };
  const labelStyle = { color: T.sub, fontSize: 12 };

  if (symbol) return (
    <section style={{ ...card, marginTop: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
      <div><div style={{ color: T.text, fontWeight: 700 }}>LLM research council · {symbol}</div><div style={{ color: T.muted, fontSize: 11, marginTop: 3 }}>10-session outlook · shadow research only · latest frozen decision evidence</div></div>
        <button onClick={() => void load()} style={{ ...selectStyle, cursor: "pointer" }}>Refresh</button>
      </div>
      {!current ? <p style={{ color: T.muted, fontSize: 13, marginBottom: 0 }}>No council run recorded for this symbol. The system is opt-in and only scores eligible research observations after the council is enabled in Settings → AI Models.</p> : <>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, margin: "16px 0" }}>
          <span style={{ color: T.accent, fontSize: 30, fontWeight: 800 }}>{current.consensus_score == null ? "—" : Number(current.consensus_score).toFixed(1)}</span>
          <span style={{ color: T.sub, fontSize: 12 }}>median composite · {current.status} · data as of {new Date(current.decision_ts).toLocaleString()}</span>
        </div>
        {current.consensus_summary && <p style={{ color: T.text, lineHeight: 1.55, fontSize: 13 }}>{current.consensus_summary}</p>}
        {current.disagreement_summary && <p style={{ color: T.sub, whiteSpace: "pre-wrap", lineHeight: 1.5, fontSize: 12 }}><b style={{ color: T.text }}>Disagreement and risks: </b>{current.disagreement_summary}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 10 }}>
          {forecasts.map((row) => <div key={row.model_requested} style={{ background: T.surface, borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><b style={{ color: T.text, fontSize: 12 }}>{row.model_requested}</b><b style={{ color: T.accent }}>{row.final_score == null ? "—" : Number(row.final_score).toFixed(1)}</b></div>
            <div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>independent {row.initial_score ?? "—"} → debated {row.final_score ?? "—"} · confidence {row.confidence ?? "—"}</div>
            <p style={{ color: T.sub, fontSize: 12, lineHeight: 1.45, marginBottom: 8 }}>{row.final_rationale || "No valid forecast."}</p>
            <div style={{ color: T.muted, fontSize: 10 }}>Bull: {row.bull_case || "—"}<br />Bear: {row.bear_case || "—"}</div>
            {!!row.evidence_citations?.length && <details style={{ marginTop: 8, color: T.sub, fontSize: 10 }}><summary>Evidence citations and as-of dates</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(row.evidence_citations, null, 2)}</pre></details>}
          </div>)}
        </div>
        {turns.length > 0 && <div style={{ marginTop: 12 }}><button onClick={() => setShowTurns(!showTurns)} style={{ ...selectStyle, cursor: "pointer", fontSize: 11 }}>{showTurns ? "Hide" : "Show"} debate turns ({turns.length})</button>{showTurns && <div style={{ marginTop: 8, display: "grid", gap: 6 }}>{turns.map((turn, index) => <details key={index} style={{ color: T.sub, background: T.surface, borderRadius: 6, padding: 8 }}><summary>{turn.turn_role} · round {turn.round} · {turn.model_requested} · {turn.status}</summary><pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{turn.output_text}</pre></details>)}</div>}</div>}
        <div style={{ color: T.muted, fontSize: 10, marginTop: 10 }}>Cost ${Number(current.cost_usd).toFixed(4)} · {current.tokens_in + current.tokens_out} tokens · evaluated score is not connected to trading.</div>
      </>}
      {error && <div style={{ color: T.red, fontSize: 12, marginTop: 8 }}>{error}</div>}
    </section>
  );

  const effectiveRounds = effectiveCouncilDebateRounds(config.participant_models.length, config.debate_rounds);
  const estimatedCalls = config.participant_models.length * (1 + effectiveRounds) + 1;
  const requiredProviders = [...new Set([...config.participant_models, config.orchestrator_model].map((model) => payload.modelProviders?.[model]).filter(Boolean))];
  const missingProviders = requiredProviders.filter((provider) => payload.providerKeyReadiness?.[provider] !== true);
  const usageGroups = groupCouncilUsageRows(usage?.rows ?? []);
  return <section style={{ ...card, marginTop: 18 }}>
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><div style={{ color: T.text, fontWeight: 700 }}>Multi-LLM research council</div><div style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>Independent scores → bounded debate → median (or single-model baseline) → multi-horizon IC. Shadow-only; it cannot trade.</div></div>
      <span style={{ borderRadius: 999, padding: "4px 9px", fontSize: 11, color: config.enabled ? T.green : T.muted, background: T.surface }}>{config.enabled ? "ENABLED · SHADOW" : "OFF"}</span>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, marginTop: 18 }}>
      <label style={labelStyle}>Council
        <select disabled={busy} value={String(config.enabled)} onChange={(e) => void save({ enabled: e.target.value === "true" })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}><option value="false">Off (default)</option><option value="true">On · research shadow only</option></select>
      </label>
      <label style={labelStyle}>Execution source
        <select disabled={busy || config.enabled} value={config.execution_mode ?? "api"} onChange={e => void save({ execution_mode: e.target.value as "api" | "subscription" })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}><option value="api">API models · metered billing</option><option value="subscription">Subscription workers · Claude / Codex</option></select>
      </label>
      {!subscription && <label style={labelStyle}>Orchestrator
        <select disabled={busy} value={config.orchestrator_model} onChange={(e) => void save({ orchestrator_model: e.target.value })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}>{MODELS.map((m) => <option key={m} value={m}>{m} · {PROVIDER[m]}</option>)}</select>
      </label>}
      <label style={labelStyle}>Debate rounds (0–3)
        <select disabled={busy} value={config.debate_rounds} onChange={(e) => void save({ debate_rounds: Number(e.target.value) })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}>{[0,1,2,3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </label>
      <label style={labelStyle}>Max symbols / market / day (minimum 5 qualifying names per session for rank IC)
        <input type="number" min={1} max={5} disabled={busy} value={numericDrafts.symbols ?? String(config.max_symbols_per_market_day)} onChange={(e) => setNumericDrafts((d) => ({ ...d, symbols: e.target.value }))} onBlur={() => {
          const value = Number(numericDrafts.symbols);
          setNumericDrafts((d) => { const next = { ...d }; delete next.symbols; return next; });
          if (Number.isInteger(value) && value >= 1 && value <= 5 && value !== config.max_symbols_per_market_day) void save({ max_symbols_per_market_day: value });
        }} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }} />
      </label>
      {!subscription && <label style={labelStyle}>Hard daily budget (USD)
        <input type="number" min={0} max={100} step={0.25} disabled={busy} value={numericDrafts.budget ?? String(config.daily_budget_usd)} onChange={(e) => setNumericDrafts((d) => ({ ...d, budget: e.target.value }))} onBlur={() => {
          const value = Number(numericDrafts.budget);
          setNumericDrafts((d) => { const next = { ...d }; delete next.budget; return next; });
          if (Number.isFinite(value) && value >= 0 && value <= 100 && value !== Number(config.daily_budget_usd)) void save({ daily_budget_usd: value });
        }} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }} />
      </label>}
    </div>
    {subscription ? <CouncilSubscriptionWorkers selected={config.subscription_worker_ids ?? []} disabled={busy} onSelect={ids => void save({ subscription_worker_ids: ids })} /> : <>
    <div style={{ marginTop: 14, color: T.sub, fontSize: 12 }}>Estimated maximum: {estimatedCalls} model calls per symbol · {config.max_symbols_per_market_day} symbols per market/day · {config.daily_budget_usd ? `$${config.daily_budget_usd}/day` : "$0 budget (no calls)"}. Calls reserve cost pessimistically before dispatch; actual spend comes from the LLM call ledger.</div>
    <div style={{ marginTop: 8, color: missingProviders.length ? T.red : T.green, fontSize: 12 }}>
      {missingProviders.length ? `Missing provider API key: ${missingProviders.join(", ")} — add it in Settings → AI Models before enabling.` : "Provider API keys are configured for the selected models."}
    </div>
    <div style={{ marginTop: 5, color: T.muted, fontSize: 11 }}>API mode uses provider API billing. To use Claude or Codex memberships instead, switch the council off and select Subscription workers above. Memberships do not become API keys.</div>
    <div style={{ marginTop: 16, color: T.text, fontSize: 12, fontWeight: 700 }}>Independent model participants</div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 6, marginTop: 8 }}>
      {MODELS.map((model) => <label key={model} style={{ color: T.sub, fontSize: 11, display: "flex", gap: 8, alignItems: "center", background: T.surface, padding: 8, borderRadius: 6 }}>
        <input type="checkbox" disabled={busy} checked={config.participant_models.includes(model)} onChange={(e) => {
          const next = e.target.checked ? [...config.participant_models, model] : config.participant_models.filter((x) => x !== model);
          if (next.length > 5) { setError("Select at most 5 participants."); return; }
          void save({ participant_models: next });
        }} />{model}<span style={{ color: T.muted }}>({PROVIDER[model]})</span>
      </label>)}
    </div>
    <div style={{ marginTop: 6, color: T.muted, fontSize: 11 }}>Recommended starting trio: DeepSeek Flash, GPT-5.6 Luna (medium reasoning), and Claude Sonnet 4.6. Every member sees the same frozen packet independently; the orchestrator explains disagreements but cannot alter the numeric median. The paired table includes deterministic-only and a fixed 50/50 blend on the exact same observations—no weights are fit to history.</div>
    </>}
    {notice && <div style={{ color: T.green, fontSize: 12, marginTop: 8 }}>{notice}</div>}
    {error && <div style={{ color: T.red, fontSize: 12, marginTop: 8 }}>{error}</div>}
    <div style={{ marginTop: 18, color: T.text, fontSize: 12, fontWeight: 700 }}>Latest per-model / composite IC</div>
    <div style={{ overflowX: "auto", marginTop: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 760 }}><thead><tr>{["Market", "Horizon", "Cohort", "Series", "Rank IC", "t-stat", "Sessions", "Effective windows", "State"].map((x) => <th key={x} style={{ textAlign: "left", color: T.muted, padding: 7, borderBottom: `1px solid ${T.border}` }}>{x}</th>)}</tr></thead><tbody>{latestCells.slice(0, 32).map((row) => <tr key={`${row.market}-${row.horizon_days}-${row.cohort_key}-${row.series_key}`}><td style={{ color: T.sub, padding: 7 }}>{row.market}</td><td style={{ color: T.sub, padding: 7 }}>h{row.horizon_days}</td><td style={{ color: T.sub, padding: 7 }}>{row.cohort_key}</td><td style={{ color: T.sub, padding: 7 }}>{row.series_key}</td><td style={{ color: T.text, padding: 7 }}>{row.mean_session_rank_ic == null ? "—" : Number(row.mean_session_rank_ic).toFixed(3)}</td><td style={{ color: T.text, padding: 7 }}>{row.t_stat == null ? "insufficient" : Number(row.t_stat).toFixed(2)}</td><td style={{ color: T.sub, padding: 7 }}>{row.qualifying_sessions}</td><td style={{ color: T.sub, padding: 7 }}>{Number(row.independent_windows).toFixed(1)}</td><td style={{ color: row.classification === "measured_descriptive" ? T.green : T.muted, padding: 7 }}>{row.classification}</td></tr>)}</tbody></table></div>
    {latestCells.length === 0 && <div style={{ color: T.muted, fontSize: 12, padding: 12 }}>No evaluation runs yet. Insufficient evidence is an expected status until enough labels mature.</div>}
    {subscription && <div role="note" style={{ color: T.yellow, fontSize: 11, marginTop: 8 }}>Subscription forecasts arrive after the frozen research observation and are intentionally excluded from these IC/t-stat rows. They need a separate availability-aligned return label before they can be fairly compared.</div>}
    <div style={{ marginTop: 18, color: T.text, fontSize: 12, fontWeight: 700 }}>Recent council symbols</div>
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>{runs.slice(0, 8).map((row) => <a key={row.id} href={`/dashboard/research/${encodeURIComponent(row.symbol)}`} style={{ color: T.sub, display: "flex", justifyContent: "space-between", gap: 10, textDecoration: "none", padding: "7px 9px", background: T.surface, borderRadius: 6, fontSize: 11 }}><span>{row.market.toUpperCase()} · {row.symbol} · {new Date(row.decision_ts).toLocaleDateString()}</span><span style={{ color: T.accent }}>LLM {row.consensus_score ?? "—"} · {row.status}</span></a>)}</div>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 20 }}>
      <div>
        <div style={{ color: T.text, fontSize: 12, fontWeight: 700 }}>Daily model usage by pipeline</div>
        <div style={{ color: T.muted, fontSize: 10, marginTop: 3 }}>Dates use US Eastern or India time. API cost is Kairos&apos; router estimate; subscription jobs are not assigned a made-up API charge.</div>
      </div>
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 7 }}>Lookback
        <select aria-label="Council usage lookback" disabled={usageBusy} value={usageDays} onChange={(e) => setUsageDays(Number(e.target.value))} style={selectStyle}>
          {[7, 30, 90].map((days) => <option key={days} value={days}>{days} days</option>)}
        </select>
      </label>
    </div>
    {usage?.asOf && <div style={{ color: T.muted, fontSize: 10, marginTop: 5 }}>Snapshot retrieved {new Date(usage.asOf).toLocaleString()} · {usageBusy ? "refreshing…" : ""}</div>}
    {usageError && <div role="alert" style={{ color: T.red, fontSize: 12, marginTop: 8 }}>{usageError}</div>}
    {usageBusy && !usage ? <div style={{ color: T.muted, fontSize: 12, padding: 12 }}>Loading dated usage…</div> : usageGroups.length === 0 ? <div style={{ color: T.muted, fontSize: 12, padding: 12 }}>{usageError ? "Usage could not be verified." : `No council usage records in the last ${usageDays} market-local days.`}</div> : <div style={{ overflowX: "auto", marginTop: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 850 }}>
        <thead><tr>{["Market-local date", "Pipeline", "Source", "Turns / jobs", "Input tokens", "Output tokens", "Unreported fields", "API cost estimate", "Failures", "Details"].map((x) => <th key={x} style={{ textAlign: "left", color: T.muted, padding: 7, borderBottom: `1px solid ${T.border}` }}>{x}</th>)}</tr></thead>
        <tbody>{usageGroups.map((group) => <tr key={`${group.usageDate}-${group.market}-${group.executionSource}`}>
          <td title={group.timestampBasis} style={{ color: T.sub, padding: 7, whiteSpace: "nowrap" }}><div>{group.usageDate} <span style={{ color: T.muted }}>{group.market === "india" ? "IST" : "ET"}</span></div><div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{group.timestampBasis}</div></td>
          <td style={{ color: T.sub, padding: 7 }}>{group.market.toUpperCase()}</td>
          <td style={{ color: T.sub, padding: 7 }}>{group.executionSource === "api" ? "API" : "Subscription"}</td>
          <td title={group.executionSource === "subscription" ? "Unique persisted worker jobs, not necessarily provider invocations; retries can consume membership usage without a second row." : "Persisted council turn records; each row represents a council stage."} style={{ color: T.sub, padding: 7 }}>{group.records.toLocaleString()}{group.executionSource === "subscription" && group.leaseAttempts ? <span style={{ color: T.muted }}> · {group.leaseAttempts} lease claims</span> : null}</td>
          <td style={{ color: T.sub, padding: 7 }}>{group.inputTokens.toLocaleString()}</td>
          <td style={{ color: T.sub, padding: 7 }}>{group.outputTokens.toLocaleString()}</td>
          <td title="Rows where the provider/client did not report this token count; not treated as zero usage." style={{ color: group.inputUnknownRecords || group.outputUnknownRecords ? T.yellow : T.sub, padding: 7 }}>{group.inputUnknownRecords + group.outputUnknownRecords || "—"}</td>
          <td title={group.executionSource === "api" ? "Estimated by Kairos from the configured model rate; unknown means a failed call did not return verifiable usage." : "Subscription usage; Kairos does not have a per-call dollar amount."} style={{ color: T.text, padding: 7 }}>{group.estimatedApiCostUsd == null ? (group.executionSource === "subscription" ? "Membership · n/a" : "Unknown") : `$${group.estimatedApiCostUsd.toFixed(4)}`}</td>
          <td style={{ color: group.failures ? T.red : T.sub, padding: 7 }}>{group.failures}</td>
          <td style={{ color: T.sub, padding: 7 }}><details><summary style={{ cursor: "pointer" }}>Models ({group.details.length})</summary><div style={{ minWidth: 300, paddingTop: 6 }}>{group.details.map((detail, index) => <div key={`${detail.modelRequested}-${detail.role}-${index}`} style={{ padding: "5px 0", borderTop: `1px solid ${T.border}` }}><div style={{ color: T.text }}>{detail.modelRequested}{detail.modelActual !== detail.modelRequested ? ` → ${detail.modelActual}` : ""}</div><div style={{ color: T.muted, marginTop: 2 }}>{detail.role} · {detail.records} record(s) · {detail.inputTokens.toLocaleString()} in / {detail.outputTokens.toLocaleString()} out{detail.inputUnknownRecords || detail.outputUnknownRecords ? ` · token fields missing ${detail.inputUnknownRecords + detail.outputUnknownRecords}` : ""}{detail.estimatedApiCostUsd == null ? (group.executionSource === "subscription" ? " · membership; no API price" : " · usage cost unknown") : ` · $${detail.estimatedApiCostUsd.toFixed(4)}`} · {detail.failures} failure(s){detail.leaseAttempts ? ` · ${detail.leaseAttempts} lease claim(s)` : ""}</div></div>)}</div></details></td>
        </tr>)}</tbody>
      </table>
    </div>}
    <div style={{ color: T.muted, fontSize: 10, marginTop: 6 }}>“Turns / jobs” are ledger records, not guaranteed unique provider invocations. Subscription retries may consume membership usage without a second submitted result; lease claims are shown separately. Synthetic test batches are excluded. “Unreported” token counts are unknown, never counted as zero. Subscription dates use result-reported time; expired jobs without a result use the queued/lease date and are marked as uncertain.</div>
  </section>;
}
