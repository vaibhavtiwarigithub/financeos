"use client";
import { useCallback, useEffect, useState } from "react";
import { CODEX_SUBSCRIPTION_MODEL_OPTIONS, DEFAULT_CODEX_SUBSCRIPTION_MODEL } from "@/lib/llm-council/worker-model-options";

type Worker = { id: string; label: string; family: string; expected_model: string; revoked_at: string | null; last_seen_at: string | null };
type Job = { id: string; worker_id: string; round: number; status: string; actual_model: string | null; failure_code: string | null; tokens_in: number | null; tokens_out: number | null; result: { score?: number } | null };
type Batch = { id: string; synthetic: boolean; status: string; consensus_score: number | null; created_at: string; deadline: string; llm_council_jobs: Job[] };
const T = { surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", accent: "#818cf8", red: "#f87171" };
const control = { background: T.surface, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: 9 };

export default function CouncilSubscriptionWorkers({ selected, disabled, onSelect }: { selected: string[]; disabled: boolean; onSelect: (ids: string[]) => void }) {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [family, setFamily] = useState("codex");
  const [model, setModel] = useState(DEFAULT_CODEX_SUBSCRIPTION_MODEL);
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/agents/llm-council/workers", { cache: "no-store" }); const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Unable to load workers");
      setWorkers(data.workers); setBatches(data.batches); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load workers"); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function action(body: object) {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/agents/llm-council/workers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || "Action failed");
      if (data.token) setToken(data.token);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Action failed"); }
    setBusy(false);
  }
  return <div style={{ marginTop: 16, color: T.sub, fontSize: 12 }}>
    <p>Use your signed-in Claude Code or Codex client. Kairos supplies a frozen packet; workers return structured scores. The server never receives your provider login. This is not cloud execution: schedule the local runner and keep its machine awake. No paid API fallback; subscription usage limits still apply.</p>
    <p>1. Register a worker → 2. Configure its private runner → 3. Select it and pass a synthetic test → 4. Turn on the council above.</p>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,200px),1fr))", gap: 10 }}>
      <label>Worker name<input aria-label="Worker name" value={label} onChange={e => setLabel(e.target.value)} maxLength={80} style={{ ...control, width: "100%", boxSizing: "border-box", display: "block" }} /></label>
      <label>Signed-in client<select value={family} onChange={e => { const nextFamily = e.target.value; setFamily(nextFamily); setModel(nextFamily === "codex" ? DEFAULT_CODEX_SUBSCRIPTION_MODEL : ""); }} style={{ ...control, width: "100%", display: "block" }}><option value="codex">Codex · ChatGPT membership</option><option value="claude">Claude Code · Claude membership</option></select></label>
      {family === "codex" ? <label>Codex model<select aria-label="Codex model" value={CODEX_SUBSCRIPTION_MODEL_OPTIONS.some(option => option.id === model) ? model : "custom"} onChange={e => setModel(e.target.value === "custom" ? "" : e.target.value)} style={{ ...control, width: "100%", display: "block" }}>{CODEX_SUBSCRIPTION_MODEL_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}<option value="custom">Another model ID…</option></select></label> : null}
      {family === "claude" || !CODEX_SUBSCRIPTION_MODEL_OPTIONS.some(option => option.id === model) ? <label>Exact model ID<input aria-label="Exact supported model ID" value={model} onChange={e => setModel(e.target.value)} placeholder="Use the exact ID shown by your signed-in CLI" style={{ ...control, width: "100%", boxSizing: "border-box", display: "block" }} /></label> : null}
      <button disabled={busy || !label.trim() || !model.trim()} onClick={() => void action({ action: "register", label, family, expected_model: model })} style={control}>Register worker</button>
    </div>
    {family === "codex" && <p>GPT-5.6 Luna is preselected and passed a local synthetic Codex CLI check. This is not yet a Kairos queue test. Before registering a different/future model, confirm its exact ID with <code>codex debug models</code> on the machine that will run the worker; newer IDs can be entered under “Another model ID…”.</p>}
    {token && <div style={{ border: `1px solid ${T.accent}`, padding: 12, marginTop: 12 }} role="status"><b style={{ color: T.text }}>Private worker token — shown once</b><p>Store it in your runner’s private credential file. Never put it in a prompt, screenshot, source control or provider settings.</p><input readOnly type="password" aria-label="New worker token" value={token} style={{ ...control, width: "100%", boxSizing: "border-box" }} /><button style={control} onClick={() => void navigator.clipboard.writeText(token).catch(() => setError("Clipboard unavailable; select and copy the token manually."))}>Copy token</button> <button style={control} onClick={() => setToken("")}>Dismiss</button></div>}
    <div style={{ display: "grid", gap: 8, marginTop: 14 }}>{workers.filter(w => !w.revoked_at).map(w => <div key={w.id} style={{ padding: 10, background: T.surface, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <label style={{ flex: 1 }}><input type="checkbox" checked={selected.includes(w.id)} disabled={disabled || busy} onChange={e => {
        const next = e.target.checked ? [...selected, w.id] : selected.filter(id => id !== w.id);
        if (next.length > 5) { setError("Choose at most five workers."); return; } onSelect(next);
      }} /> <b style={{ color: T.text }}>{w.label}</b> · {w.family} / {w.expected_model}<br />Last connected: {w.last_seen_at ? new Date(w.last_seen_at).toLocaleString() : "Never — runner not connected"}</label>
      <button disabled={busy} style={control} onClick={() => { if (window.confirm(`Revoke ${w.label}? Its token will stop working immediately.`)) void action({ action: "revoke", worker_id: w.id }); }}>Revoke</button>
    </div>)}</div>
    {!workers.length && <p>No workers registered yet.</p>}
    <p>Choose 1–5 workers. Multiple members require both Claude and Codex families. No LLM orchestrator is needed: the numeric result is a deterministic median. Each selected worker must pass a test before enabling real research.</p>
    <button disabled={busy || !selected.length} onClick={() => void action({ action: "synthetic", worker_ids: selected })} style={control}>Queue synthetic test</button> <button disabled={busy} onClick={() => void load()} style={control}>Refresh worker evidence</button>
    {error && <p role="alert" style={{ color: T.red }}>{error}</p>}
    <p>Subscription forecasts are kept separate from API IC statistics until submission-time-aligned outcome labels are available. A successful transport test is not evidence of investment skill.</p>
    {batches.slice(0, 8).map(b => <details key={b.id} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 0" }}><summary>{b.synthetic ? "Synthetic test" : "Research batch"} · {b.status} · median {b.consensus_score ?? "—"} · {new Date(b.created_at).toLocaleString()}</summary>
      <div>Deadline: {new Date(b.deadline).toLocaleString()}</div>{b.llm_council_jobs.map(j => <div key={j.id} style={{ marginTop: 6 }}>{workers.find(w => w.id === j.worker_id)?.label ?? j.worker_id} · round {j.round} · {j.status} · score {j.result?.score ?? "—"}{j.failure_code ? ` · ${j.failure_code}` : ""} · tokens {j.tokens_in == null || j.tokens_out == null ? "not reported" : j.tokens_in + j.tokens_out}</div>)}
    </details>)}
  </div>;
}
