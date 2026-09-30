"use client";
import { useCallback, useEffect, useMemo, useState } from "react";

type CouncilConfig = {
  enabled: boolean;
  participant_models: string[];
  orchestrator_model: string;
  debate_rounds: number;
  max_symbols_per_market_day: number;
  daily_budget_usd: number;
};
type Run = { id: string; symbol: string; market: string; decision_ts: string; status: string; consensus_score: number | null; consensus_summary: string | null; disagreement_summary: string | null; tokens_in: number; tokens_out: number; cost_usd: number };
type Forecast = { run_id: string; model_requested: string; model_used: string | null; initial_score: number | null; final_score: number | null; confidence: number | null; initial_rationale: string | null; final_rationale: string | null; bull_case: string | null; bear_case: string | null; evidence_citations: Array<{ claim: string; source: string; as_of: string }>; status: string };
type Turn = { run_id: string; model_requested: string; model_used: string | null; turn_role: string; round: number; output_json?: any; output_text?: string | null; tokens_in: number; tokens_out: number; cost_usd: number; status: string };
type IcRow = { market: string; horizon_days: number; series_key: string; forecast_model: string | null; observation_count: number; qualifying_sessions: number; independent_windows: number; mean_session_rank_ic: number | null; t_stat: number | null; classification: string; evaluated_at: string };
type Payload = { config: CouncilConfig; runs: Run[]; forecasts: Forecast[]; turns: Turn[]; ic: IcRow[] };

const MODELS = [
  "deepseek-flash", "deepseek-v4-pro", "llama-3.3-70b-versatile", "llama-3.1-8b-instant", "deepseek-r1-distill-llama-70b",
  "claude-haiku-4-5", "claude-sonnet-4-6", "gemini-2.5-flash", "gemini-2.5-pro", "grok-4-fast", "grok-4",
  "gpt-4o-mini", "gpt-4o", "gpt-4.1", "glm-4.5-air", "glm-4.6",
];
const PROVIDER: Record<string, string> = {
  "deepseek-flash": "DeepSeek", "deepseek-v4-pro": "DeepSeek", "llama-3.3-70b-versatile": "Groq", "llama-3.1-8b-instant": "Groq", "deepseek-r1-distill-llama-70b": "Groq",
  "claude-haiku-4-5": "Anthropic", "claude-sonnet-4-6": "Anthropic", "gemini-2.5-flash": "Google", "gemini-2.5-pro": "Google", "grok-4-fast": "xAI", "grok-4": "xAI",
  "gpt-4o-mini": "OpenAI", "gpt-4o": "OpenAI", "gpt-4.1": "OpenAI", "glm-4.5-air": "Zhipu", "glm-4.6": "Zhipu",
};
const T = { card: "#1A1D27", border: "#252836", surface: "#13151C", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#818cf8", green: "#34D399", red: "#f87171" };

export default function LLMCouncilPanel({ symbol, market }: { symbol?: string; market?: "us" | "india" }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTurns, setShowTurns] = useState(false);
  const [numericDrafts, setNumericDrafts] = useState<Record<string, string>>({});
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

  async function save(patch: Partial<CouncilConfig>) {
    if (!payload) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/agents/llm-council", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload.config, ...patch }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "Save failed");
      setPayload({ ...payload, config: json.config });
      setNotice("Saved");
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed"); }
    setBusy(false);
  }

  const latestCells = useMemo(() => {
    const map = new Map<string, IcRow>();
    for (const cell of payload?.ic ?? []) {
      const key = `${cell.market}:${cell.horizon_days}:${cell.series_key}`;
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

  const estimatedCalls = config.participant_models.length * (1 + config.debate_rounds) + 1;
  const modelUsage = new Map<string, { calls: number; input: number; output: number; cost: number; failures: number }>();
  for (const turn of turns) {
    const item = modelUsage.get(turn.model_requested) ?? { calls: 0, input: 0, output: 0, cost: 0, failures: 0 };
    item.calls += 1;
    item.input += Number(turn.tokens_in ?? 0);
    item.output += Number(turn.tokens_out ?? 0);
    item.cost += Number(turn.cost_usd ?? 0);
    if (turn.status !== "completed") item.failures += 1;
    modelUsage.set(turn.model_requested, item);
  }
  return <section style={{ ...card, marginTop: 18 }}>
    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
      <div><div style={{ color: T.text, fontWeight: 700 }}>Multi-LLM research council</div><div style={{ color: T.muted, fontSize: 12, marginTop: 3 }}>Independent scores → bounded debate → median consensus → multi-horizon IC. Shadow-only; it cannot trade.</div></div>
      <span style={{ borderRadius: 999, padding: "4px 9px", fontSize: 11, color: config.enabled ? T.green : T.muted, background: T.surface }}>{config.enabled ? "ENABLED · SHADOW" : "OFF"}</span>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", gap: 14, marginTop: 18 }}>
      <label style={labelStyle}>Council
        <select disabled={busy} value={String(config.enabled)} onChange={(e) => void save({ enabled: e.target.value === "true" })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}><option value="false">Off (default)</option><option value="true">On · research shadow only</option></select>
      </label>
      <label style={labelStyle}>Orchestrator
        <select disabled={busy} value={config.orchestrator_model} onChange={(e) => void save({ orchestrator_model: e.target.value })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}>{MODELS.map((m) => <option key={m} value={m}>{m} · {PROVIDER[m]}</option>)}</select>
      </label>
      <label style={labelStyle}>Debate rounds (0–3)
        <select disabled={busy} value={config.debate_rounds} onChange={(e) => void save({ debate_rounds: Number(e.target.value) })} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }}>{[0,1,2,3].map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </label>
      <label style={labelStyle}>Max symbols / market / day (minimum 5 for rank IC)
        <input type="number" min={1} max={5} disabled={busy} value={numericDrafts.symbols ?? String(config.max_symbols_per_market_day)} onChange={(e) => setNumericDrafts((d) => ({ ...d, symbols: e.target.value }))} onBlur={() => {
          const value = Number(numericDrafts.symbols);
          setNumericDrafts((d) => { const next = { ...d }; delete next.symbols; return next; });
          if (Number.isInteger(value) && value >= 1 && value <= 5 && value !== config.max_symbols_per_market_day) void save({ max_symbols_per_market_day: value });
        }} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }} />
      </label>
      <label style={labelStyle}>Hard daily budget (USD)
        <input type="number" min={0} max={100} step={0.25} disabled={busy} value={numericDrafts.budget ?? String(config.daily_budget_usd)} onChange={(e) => setNumericDrafts((d) => ({ ...d, budget: e.target.value }))} onBlur={() => {
          const value = Number(numericDrafts.budget);
          setNumericDrafts((d) => { const next = { ...d }; delete next.budget; return next; });
          if (Number.isFinite(value) && value >= 0 && value <= 100 && value !== Number(config.daily_budget_usd)) void save({ daily_budget_usd: value });
        }} style={{ ...selectStyle, display: "block", width: "100%", marginTop: 5 }} />
      </label>
    </div>
    <div style={{ marginTop: 14, color: T.sub, fontSize: 12 }}>Estimated maximum: {estimatedCalls} model calls per symbol · {config.max_symbols_per_market_day} symbols per market/day · {config.daily_budget_usd ? `$${config.daily_budget_usd}/day` : "$0 budget (no calls)"}. Calls reserve cost pessimistically before dispatch; actual spend comes from the LLM call ledger.</div>
    <div style={{ marginTop: 16, color: T.text, fontSize: 12, fontWeight: 700 }}>Independent model participants</div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", gap: 6, marginTop: 8 }}>
      {MODELS.map((model) => <label key={model} style={{ color: T.sub, fontSize: 11, display: "flex", gap: 8, alignItems: "center", background: T.surface, padding: 8, borderRadius: 6 }}>
        <input type="checkbox" disabled={busy} checked={config.participant_models.includes(model)} onChange={(e) => {
          const next = e.target.checked ? [...config.participant_models, model] : config.participant_models.filter((x) => x !== model);
          if (next.length > 3) { setError("Select no more than 3 participants; swap models to compare more providers."); return; }
          void save({ participant_models: next });
        }} />{model}<span style={{ color: T.muted }}>({PROVIDER[model]})</span>
      </label>)}
    </div>
    {notice && <div style={{ color: T.green, fontSize: 12, marginTop: 8 }}>{notice}</div>}
    {error && <div style={{ color: T.red, fontSize: 12, marginTop: 8 }}>{error}</div>}
    <div style={{ marginTop: 18, color: T.text, fontSize: 12, fontWeight: 700 }}>Latest per-model / composite IC</div>
    <div style={{ overflowX: "auto", marginTop: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 700 }}><thead><tr>{["Market", "Horizon", "Series", "Rank IC", "t-stat", "Sessions", "Effective windows", "State"].map((x) => <th key={x} style={{ textAlign: "left", color: T.muted, padding: 7, borderBottom: `1px solid ${T.border}` }}>{x}</th>)}</tr></thead><tbody>{latestCells.slice(0, 32).map((row) => <tr key={`${row.market}-${row.horizon_days}-${row.series_key}`}><td style={{ color: T.sub, padding: 7 }}>{row.market}</td><td style={{ color: T.sub, padding: 7 }}>h{row.horizon_days}</td><td style={{ color: T.sub, padding: 7 }}>{row.series_key}</td><td style={{ color: T.text, padding: 7 }}>{row.mean_session_rank_ic == null ? "—" : Number(row.mean_session_rank_ic).toFixed(3)}</td><td style={{ color: T.text, padding: 7 }}>{row.t_stat == null ? "insufficient" : Number(row.t_stat).toFixed(2)}</td><td style={{ color: T.sub, padding: 7 }}>{row.qualifying_sessions}</td><td style={{ color: T.sub, padding: 7 }}>{Number(row.independent_windows).toFixed(1)}</td><td style={{ color: row.classification === "measured_descriptive" ? T.green : T.muted, padding: 7 }}>{row.classification}</td></tr>)}</tbody></table></div>
    {latestCells.length === 0 && <div style={{ color: T.muted, fontSize: 12, padding: 12 }}>No evaluation runs yet. Insufficient evidence is an expected status until enough labels mature.</div>}
    <div style={{ marginTop: 18, color: T.text, fontSize: 12, fontWeight: 700 }}>Recent council symbols</div>
    <div style={{ display: "grid", gap: 6, marginTop: 8 }}>{runs.slice(0, 8).map((row) => <a key={row.id} href={`/dashboard/research/${encodeURIComponent(row.symbol)}`} style={{ color: T.sub, display: "flex", justifyContent: "space-between", gap: 10, textDecoration: "none", padding: "7px 9px", background: T.surface, borderRadius: 6, fontSize: 11 }}><span>{row.market.toUpperCase()} · {row.symbol} · {new Date(row.decision_ts).toLocaleDateString()}</span><span style={{ color: T.accent }}>LLM {row.consensus_score ?? "—"} · {row.status}</span></a>)}</div>
    <div style={{ marginTop: 18, color: T.text, fontSize: 12, fontWeight: 700 }}>Per-model usage · recent runs</div>
    <div style={{ overflowX: "auto", marginTop: 8 }}><table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 580 }}><thead><tr>{["Requested model", "Calls", "Input tokens", "Output tokens", "Cost", "Failures"].map((x) => <th key={x} style={{ textAlign: "left", color: T.muted, padding: 7, borderBottom: `1px solid ${T.border}` }}>{x}</th>)}</tr></thead><tbody>{[...modelUsage.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([model, usage]) => <tr key={model}><td style={{ color: T.sub, padding: 7 }}>{model}</td><td style={{ color: T.sub, padding: 7 }}>{usage.calls}</td><td style={{ color: T.sub, padding: 7 }}>{usage.input.toLocaleString()}</td><td style={{ color: T.sub, padding: 7 }}>{usage.output.toLocaleString()}</td><td style={{ color: T.text, padding: 7 }}>${usage.cost.toFixed(4)}</td><td style={{ color: usage.failures ? T.red : T.sub, padding: 7 }}>{usage.failures}</td></tr>)}</tbody></table></div>
  </section>;
}
