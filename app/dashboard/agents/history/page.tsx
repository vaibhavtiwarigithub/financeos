"use client";
import { useState, useEffect, useCallback } from "react";
import PageHeader from "@/components/dashboard/PageHeader";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16", red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2A1A00", purple: "#A78BFA",
};

const AGENT_META: Record<string, { label: string; icon: string; color: string }> = {
  research:         { label: "ResearchAgent",   icon: "◐", color: T.accent },
  paper_trader:     { label: "PaperTrader",     icon: "◫", color: T.green },
  position_monitor: { label: "PositionMonitor", icon: "▣", color: T.amber },
  learner:          { label: "LearnerAgent",    icon: "◫", color: "#60A5FA" },
  mentor_evaluate:  { label: "Mentor",          icon: "🎓", color: T.purple },
  deep_dive:        { label: "Deep-Dive",       icon: "🔬", color: T.purple },
};

interface Run {
  id: string; agent_type: string; status: string; trigger_source: string;
  symbols: string[] | null; result_summary: string | null; signals_written: number | null;
  error: string | null; started_at: string; completed_at: string | null;
  tokens_input: number | null; tokens_output: number | null;
  handoff: string | null; cost_usd: number | null; llm_calls: number; duration_ms: number | null;
}

export default function AgentHistoryPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [byAgent, setByAgent] = useState<Record<string, Run[]>>({});
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<"1d" | "1w" | "all">("1w");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/agents/history?range=${range}`);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to load");
      setRuns(d.runs ?? []);
      setByAgent(d.byAgent ?? {});
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [range]);

  useEffect(() => { load(); }, [load]);

  async function del(id: string) {
    const res = await fetch(`/api/agents/history?id=${id}`, { method: "DELETE" });
    if (res.ok) { setRuns(r => r.filter(x => x.id !== id)); setByAgent(b => { const n = { ...b }; for (const k of Object.keys(n)) n[k] = n[k].filter(x => x.id !== id); return n; }); }
  }
  async function clearRange() {
    if (!confirm(`Delete ALL agent runs in range "${range}"? This cannot be undone.`)) return;
    const res = await fetch(`/api/agents/history?clearRange=${range}`, { method: "DELETE" });
    if (res.ok) load();
  }
  function toggle(id: string) { setExpanded(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  const fmtDur = (ms: number | null) => ms == null ? "—" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  const fmtTime = (s: string) => new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

  const agentKeys = Object.keys(byAgent).sort();

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      <PageHeader
        title="Agent History"
        subtitle={`${runs.length} runs · ${range}`}
        whatItDoes="Every agent run — what it did, its result, what it handed off to the next agent, how many LLM calls it made, tokens, cost, and duration. Manual vs scheduled runs are tagged."
        whatToLookFor={[
          "Failed runs (red status) — check the error and the handoff that didn't happen",
          "Cost per run — the learner/deep-dive are the priciest; research/screener are cheap or free",
          "Manual vs scheduled — a burst of manual runs is you testing; scheduled are the crons",
          "The handoff line shows the pipeline: research → trader → monitor → learner",
        ]}
      />

      <div style={{ padding: "24px", maxWidth: "960px" }}>
        {/* Controls */}
        <div style={{ display: "flex", gap: "8px", marginBottom: "20px", alignItems: "center", flexWrap: "wrap" }}>
          {(["1d", "1w", "all"] as const).map(r => (
            <button key={r} onClick={() => setRange(r)}
              style={{ background: range === r ? T.accentBg : "transparent", border: `1px solid ${range === r ? T.accent : T.border}`, color: range === r ? T.accent : T.muted, borderRadius: "8px", padding: "6px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
              {r === "1d" ? "Last 24h" : r === "1w" ? "Last 7 days" : "All"}
            </button>
          ))}
          <button onClick={load} style={{ background: "transparent", border: `1px solid ${T.border}`, color: T.muted, borderRadius: "8px", padding: "6px 12px", fontSize: "12px", cursor: "pointer" }}>↻ Refresh</button>
          <button onClick={clearRange} style={{ background: T.redBg, border: `1px solid ${T.red}44`, color: T.red, borderRadius: "8px", padding: "6px 12px", fontSize: "12px", cursor: "pointer", marginLeft: "auto" }}>Clear {range}</button>
        </div>

        {error && <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "12px", marginBottom: "16px", color: T.red, fontSize: "13px" }}>{error}</div>}

        {loading ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>Loading…</div>
        ) : runs.length === 0 ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>No agent runs in this range.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            {agentKeys.map(agentType => {
              const meta = AGENT_META[agentType] ?? { label: agentType, icon: "●", color: T.muted };
              const agentRuns = byAgent[agentType];
              const totalCost = agentRuns.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
              return (
                <div key={agentType}>
                  {/* Agent group header */}
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
                    <span style={{ fontSize: "15px", color: meta.color }}>{meta.icon}</span>
                    <span style={{ fontSize: "14px", fontWeight: 700, color: T.text }}>{meta.label}</span>
                    <span style={{ fontSize: "11px", color: T.muted }}>{agentRuns.length} runs</span>
                    {totalCost > 0 && <span style={{ fontSize: "11px", color: T.muted }}>· ${totalCost.toFixed(4)}</span>}
                    {agentRuns[0]?.handoff && <span style={{ fontSize: "11px", color: meta.color, marginLeft: "auto", opacity: 0.8 }}>{agentRuns[0].handoff}</span>}
                  </div>

                  {/* Runs */}
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {agentRuns.map(run => {
                      const isOpen = expanded.has(run.id);
                      const failed = run.status === "error" || run.error;
                      const statusColor = failed ? T.red : run.status === "done" || run.status === "completed" ? T.green : T.amber;
                      return (
                        <div key={run.id} style={{ background: T.surface, border: `1px solid ${failed ? T.red + "44" : T.border}`, borderRadius: "10px", padding: "12px 14px" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: statusColor, flexShrink: 0 }} />
                            <span style={{ fontSize: "10px", fontWeight: 700, color: run.trigger_source === "manual" ? T.amber : T.accent, background: run.trigger_source === "manual" ? T.amberBg : T.accentBg, padding: "1px 7px", borderRadius: "4px" }}>
                              {run.trigger_source === "manual" ? "MANUAL" : "SCHEDULED"}
                            </span>
                            <span style={{ flex: 1, fontSize: "12.5px", color: T.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {run.result_summary ?? (failed ? `Error: ${run.error}` : run.status)}
                            </span>
                            <span style={{ fontSize: "11px", color: T.muted, flexShrink: 0 }}>{fmtTime(run.started_at)}</span>
                            <button onClick={() => toggle(run.id)} style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "4px", cursor: "pointer", border: `1px solid ${T.border}`, background: "transparent", color: T.muted }}>{isOpen ? "▲" : "▼"}</button>
                          </div>

                          {isOpen && (
                            <div style={{ marginTop: "10px", borderTop: `1px solid ${T.border}`, paddingTop: "10px", fontSize: "11.5px", color: T.textSub, display: "flex", flexDirection: "column", gap: "6px" }}>
                              {run.symbols?.length ? <div><b style={{ color: T.muted }}>Symbols:</b> {run.symbols.join(", ")}</div> : null}
                              <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", color: T.muted }}>
                                <span>duration: {fmtDur(run.duration_ms)}</span>
                                <span>LLM calls: {run.llm_calls}</span>
                                <span>tokens: {(run.tokens_input ?? 0).toLocaleString()} in / {(run.tokens_output ?? 0).toLocaleString()} out</span>
                                {run.cost_usd != null && <span>cost: ${run.cost_usd.toFixed(4)}</span>}
                                {run.signals_written != null && <span>signals: {run.signals_written}</span>}
                              </div>
                              {run.handoff && <div><b style={{ color: T.muted }}>Handoff:</b> {run.handoff}</div>}
                              {run.error && <div style={{ color: T.red }}><b>Error:</b> {run.error}</div>}
                              <div style={{ marginTop: "4px" }}>
                                <button onClick={() => del(run.id)} style={{ fontSize: "10px", padding: "3px 10px", borderRadius: "5px", cursor: "pointer", border: `1px solid ${T.red}44`, background: T.redBg, color: T.red, fontWeight: 600 }}>Delete run</button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
