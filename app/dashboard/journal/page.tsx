"use client";
import { useState, useEffect } from "react";
import PageHeader from "@/components/dashboard/PageHeader";
import { useMarket } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
  green: "#34D399", greenBg: "#052E16",
  red: "#F87171", redBg: "#3B0000",
  amber: "#FBBF24", amberBg: "#2A1A00",
};

const ENTRY_COLORS: Record<string, string> = {
  signal:        T.accent,
  fill:          T.green,
  exit:          T.amber,
  experiment:    "#818CF8",
  learner_run:   "#60A5FA",
  risk_override: T.red,
  note:          T.muted,
};

const ENTRY_TYPES = ["signal","fill","exit","experiment","learner_run","risk_override","note"];

interface JournalEntry {
  id: number;
  entry_type: string;
  symbol: string | null;
  summary: string;
  created_at: string;
  resolved: boolean;
  resolved_at: string | null;
  outcome: Record<string, unknown> | null;
  has_verified_facts: boolean;
  has_calculations: boolean;
  has_estimates: boolean;
  has_interpretations: boolean;
  has_user_decisions: boolean;
  signal_id: number | null;
  paper_trade_id: number | null;
  strategy_version_id: number | null;
  learner_run_id: number | null;
}

function TypeBadge({ type }: { type: string }) {
  const color = ENTRY_COLORS[type] ?? T.muted;
  return (
    <span style={{
      fontSize: "10px", fontWeight: 700, letterSpacing: "0.04em",
      padding: "2px 8px", borderRadius: "4px",
      background: color + "22", color, border: `1px solid ${color}44`,
      whiteSpace: "nowrap" as const,
    }}>
      {type.replace("_", " ").toUpperCase()}
    </span>
  );
}

function EvidenceFlags({ entry }: { entry: JournalEntry }) {
  const flags = [
    entry.has_verified_facts  && { label: "facts",    color: T.green },
    entry.has_calculations    && { label: "calc",     color: T.accent },
    entry.has_estimates       && { label: "estimate", color: T.amber },
    entry.has_interpretations && { label: "interp",   color: "#818CF8" },
    entry.has_user_decisions  && { label: "decision", color: T.red },
  ].filter(Boolean) as { label: string; color: string }[];

  if (!flags.length) return null;
  return (
    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" as const, marginTop: "6px" }}>
      {flags.map(f => (
        <span key={f.label} style={{
          fontSize: "9px", fontWeight: 600, padding: "1px 6px", borderRadius: "3px",
          background: f.color + "18", color: f.color, border: `1px solid ${f.color}33`,
        }}>{f.label}</span>
      ))}
    </div>
  );
}

export default function JournalPage() {
  const { market } = useMarket();
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [resolvedFilter, setResolvedFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    load();
  }, [market]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: "100", market });
      if (typeFilter !== "all") params.set("type", typeFilter);
      if (resolvedFilter !== "all") params.set("resolved", resolvedFilter);
      const res = await fetch(`/api/journal?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setEntries(data.entries ?? []);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function resolveEntry(id: number) {
    const outcome = { resolved_manually: true, note: "Resolved via Journal UI" };
    const res = await fetch("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resolve", id, outcome }),
    });
    if (res.ok) {
      setEntries(prev => prev.map(e => e.id === id ? { ...e, resolved: true, resolved_at: new Date().toISOString() } : e));
    }
  }

  function toggleExpand(id: number) {
    setExpanded(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  const filtered = entries.filter(e => {
    if (typeFilter !== "all" && e.entry_type !== typeFilter) return false;
    if (resolvedFilter === "open" && e.resolved) return false;
    if (resolvedFilter === "resolved" && !e.resolved) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!(e.summary.toLowerCase().includes(q) || (e.symbol ?? "").toLowerCase().includes(q))) return false;
    }
    return true;
  });

  const openCount = entries.filter(e => !e.resolved).length;

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      <PageHeader
        title="Decision Journal"
        subtitle={`${entries.length} entries · ${openCount} open`}
        whatItDoes="Audit trail of every decision the system made — signals generated, fills executed, exits triggered, experiments run, and LearnerAgent weight updates."
        whatToLookFor={[
          "Open entries without outcomes — these need review or resolution",
          "Exit decisions: did the thesis hold? Did we exit at the right time?",
          "LearnerAgent runs: what weights changed and why",
          "Risk overrides: any proposal rejected by the risk gate needs investigation",
        ]}
      />

      <div style={{ padding: "24px", maxWidth: "900px" }}>

        {/* Filters */}
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" as const, alignItems: "center" }}>
          <input
            placeholder="Search symbol or summary…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
              padding: "8px 12px", fontSize: "12px", color: T.text, outline: "none",
              flex: "1", minWidth: "180px",
            }}
          />
          <select
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value)}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: T.text, cursor: "pointer" }}
          >
            <option value="all">All types</option>
            {ENTRY_TYPES.map(t => <option key={t} value={t}>{t.replace("_"," ")}</option>)}
          </select>
          <select
            value={resolvedFilter}
            onChange={e => setResolvedFilter(e.target.value)}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "8px 10px", fontSize: "12px", color: T.text, cursor: "pointer" }}
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
          <button
            onClick={load}
            style={{ background: T.accentBg, border: `1px solid ${T.accent}44`, color: T.accent, borderRadius: "8px", padding: "8px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}
          >
            ↻ Refresh
          </button>
        </div>

        {/* Stats row */}
        <div style={{ display: "flex", gap: "10px", marginBottom: "20px", flexWrap: "wrap" as const }}>
          {ENTRY_TYPES.map(t => {
            const count = entries.filter(e => e.entry_type === t).length;
            if (!count) return null;
            const color = ENTRY_COLORS[t] ?? T.muted;
            return (
              <div key={t} onClick={() => setTypeFilter(typeFilter === t ? "all" : t)}
                style={{ background: T.surface, border: `1px solid ${typeFilter === t ? color : T.border}`, borderRadius: "8px", padding: "8px 14px", cursor: "pointer", transition: "border-color 0.15s" }}>
                <div style={{ fontSize: "18px", fontWeight: 700, color }}>{count}</div>
                <div style={{ fontSize: "10px", color: T.muted }}>{t.replace("_"," ")}</div>
              </div>
            );
          })}
        </div>

        {/* Error */}
        {error && (
          <div style={{ background: T.redBg, border: `1px solid ${T.red}44`, borderRadius: "8px", padding: "12px", marginBottom: "16px", color: T.red, fontSize: "13px" }}>
            {error}
          </div>
        )}

        {/* Entries */}
        {loading ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>Loading…</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", color: T.muted, padding: "40px" }}>No entries match filters</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filtered.map(entry => {
              const isOpen = !entry.resolved;
              const isExpanded = expanded.has(entry.id);
              const ts = new Date(entry.created_at).toLocaleString("en-US", { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" });

              return (
                <div key={entry.id} style={{
                  background: T.surface, border: `1px solid ${isOpen ? T.border : T.border + "80"}`,
                  borderRadius: "10px", padding: "14px 16px",
                  opacity: entry.resolved ? 0.7 : 1,
                }}>
                  <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                    <TypeBadge type={entry.entry_type} />
                    {entry.symbol && (
                      <span style={{ fontSize: "12px", fontWeight: 700, color: T.accent, background: T.accentBg, padding: "2px 8px", borderRadius: "4px" }}>
                        {entry.symbol}
                      </span>
                    )}
                    <span style={{ flex: 1, fontSize: "13px", color: T.text, lineHeight: "1.5" }}>{entry.summary}</span>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                      <span style={{ fontSize: "11px", color: T.muted }}>{ts}</span>
                      {isOpen && (
                        <button onClick={() => resolveEntry(entry.id)}
                          style={{ fontSize: "10px", padding: "2px 8px", borderRadius: "4px", cursor: "pointer", border: `1px solid ${T.green}44`, background: T.greenBg, color: T.green, fontWeight: 600 }}>
                          ✓ Resolve
                        </button>
                      )}
                      {entry.resolved && (
                        <span style={{ fontSize: "10px", color: T.green, background: T.greenBg, padding: "2px 8px", borderRadius: "4px", border: `1px solid ${T.green}33` }}>
                          ✓ Resolved
                        </span>
                      )}
                      <button onClick={() => toggleExpand(entry.id)}
                        style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "4px", cursor: "pointer", border: `1px solid ${T.border}`, background: "transparent", color: T.muted }}>
                        {isExpanded ? "▲" : "▼"}
                      </button>
                    </div>
                  </div>

                  <EvidenceFlags entry={entry} />

                  {isExpanded && (
                    <div style={{ marginTop: "12px", borderTop: `1px solid ${T.border}`, paddingTop: "12px" }}>
                      <div style={{ display: "flex", gap: "20px", flexWrap: "wrap" as const, fontSize: "11px", color: T.muted, marginBottom: "8px" }}>
                        {entry.signal_id       && <span>Signal #{entry.signal_id}</span>}
                        {entry.paper_trade_id  && <span>Trade #{entry.paper_trade_id}</span>}
                        {entry.learner_run_id  && <span>Learner run #{entry.learner_run_id}</span>}
                        {entry.strategy_version_id && <span>Strategy v{entry.strategy_version_id}</span>}
                      </div>
                      {entry.outcome && (
                        <div style={{ background: T.card, borderRadius: "6px", padding: "10px", fontSize: "11px", color: T.textSub, fontFamily: "monospace", whiteSpace: "pre-wrap" as const }}>
                          {JSON.stringify(entry.outcome, null, 2)}
                        </div>
                      )}
                      {entry.resolved_at && (
                        <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>
                          Resolved {new Date(entry.resolved_at).toLocaleString()}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
