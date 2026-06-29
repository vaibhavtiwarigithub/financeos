"use client";
import { useState, useEffect, useCallback } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

interface LLMLogRow {
  id: string;
  created_at: string;
  model: string;
  task_type: string;
  symbol: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
  success: boolean;
  error_msg: string | null;
  agent_label: string | null;
}

interface Summary {
  total_calls: number;
  total_cost: number;
  by_model: Record<string, { calls: number; cost: number }>;
}

type FilterModel = "all" | "claude" | "deepseek" | "other";
type FilterTime  = "7d" | "24h";

const MODEL_COLOR: Record<string, string> = {
  claude:   "#6366F1",
  deepseek: "#34D399",
  other:    "#FBBF24",
};

function modelFamily(model: string): string {
  if (model.toLowerCase().includes("claude"))    return "claude";
  if (model.toLowerCase().includes("deepseek"))  return "deepseek";
  return "other";
}

function modelColor(model: string): string {
  return MODEL_COLOR[modelFamily(model)] ?? T.muted;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function LLMHistoryPage() {
  const [rows, setRows]       = useState<LLMLogRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelFilter, setModelFilter] = useState<FilterModel>("all");
  const [timeFilter,  setTimeFilter]  = useState<FilterTime>("7d");

  const load = useCallback(async (days: number) => {
    setLoading(true);
    const res = await fetch(`/api/admin/llm-log?days=${days}`);
    const data = await res.json();
    setRows(data.rows ?? []);
    setSummary(data.summary ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    load(timeFilter === "24h" ? 1 : 7);
  }, [load, timeFilter]);

  const filtered = rows.filter(r => {
    if (modelFilter === "all") return true;
    if (modelFilter === "other") return modelFamily(r.model) === "other";
    return modelFamily(r.model) === modelFilter;
  });

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px",
  };

  function FilterBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
    return (
      <button
        onClick={onClick}
        style={{
          background: active ? T.accent + "22" : "transparent",
          border: `1px solid ${active ? T.accent : T.border}`,
          borderRadius: "6px",
          color: active ? T.accent : T.muted,
          padding: "5px 12px",
          fontSize: "12px",
          cursor: "pointer",
          fontWeight: active ? 600 : 400,
          transition: "all 0.15s",
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <div style={{ padding: "28px" }}>
      <div style={{ fontSize: "20px", fontWeight: 600, marginBottom: "6px" }}>LLM Call History</div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: "24px" }}>
        Token usage, cost, and per-call log across all models
      </div>

      {/* Summary cards */}
      {summary && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "12px", marginBottom: "24px" }}>
          <div style={card}>
            <div style={{ fontSize: "26px", fontWeight: 700, color: T.accent, fontFamily: "'JetBrains Mono', monospace" }}>
              {summary.total_calls.toLocaleString()}
            </div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>Total Calls</div>
          </div>
          <div style={card}>
            <div style={{ fontSize: "26px", fontWeight: 700, color: T.green, fontFamily: "'JetBrains Mono', monospace" }}>
              ${summary.total_cost.toFixed(4)}
            </div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "4px" }}>Total Cost</div>
          </div>
          {Object.entries(summary.by_model).map(([model, stat]) => (
            <div key={model} style={card}>
              <div style={{ fontSize: "22px", fontWeight: 700, color: modelColor(model), fontFamily: "'JetBrains Mono', monospace" }}>
                {stat.calls}
              </div>
              <div style={{ fontSize: "11px", color: T.muted, marginTop: "4px" }}>{model}</div>
              <div style={{ fontSize: "11px", color: T.muted }}>${stat.cost.toFixed(4)}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "12px", color: T.muted, marginRight: "4px" }}>Model:</span>
        {(["all", "claude", "deepseek", "other"] as FilterModel[]).map(f => (
          <FilterBtn key={f} active={modelFilter === f} onClick={() => setModelFilter(f)}>
            {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
          </FilterBtn>
        ))}
        <span style={{ fontSize: "12px", color: T.border, margin: "0 6px" }}>|</span>
        <span style={{ fontSize: "12px", color: T.muted, marginRight: "4px" }}>Time:</span>
        <FilterBtn active={timeFilter === "24h"} onClick={() => setTimeFilter("24h")}>Last 24h</FilterBtn>
        <FilterBtn active={timeFilter === "7d"}  onClick={() => setTimeFilter("7d")}>Last 7d</FilterBtn>
        {!loading && (
          <span style={{ fontSize: "12px", color: T.muted, marginLeft: "auto" }}>
            {filtered.length} rows
          </span>
        )}
      </div>

      {/* Table */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        {loading ? (
          <div style={{ padding: "48px", textAlign: "center", color: T.muted }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: "48px", textAlign: "center", color: T.muted }}>No calls found for this filter.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                  {["Timestamp", "Model", "Task", "Symbol", "Tokens In", "Tokens Out", "Cost", "Duration", "Status"].map(h => (
                    <th key={h} style={{
                      padding: "10px 14px",
                      textAlign: "left",
                      color: T.muted,
                      fontSize: "10px",
                      fontWeight: 600,
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      whiteSpace: "nowrap",
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(row => (
                  <tr
                    key={row.id}
                    style={{ borderBottom: `1px solid ${T.border}33` }}
                    title={row.error_msg ?? undefined}
                  >
                    <td style={{ padding: "9px 14px", color: T.textSub, whiteSpace: "nowrap" }}>
                      {fmtTime(row.created_at)}
                    </td>
                    <td style={{ padding: "9px 14px", whiteSpace: "nowrap" }}>
                      <span style={{
                        fontSize: "11px", padding: "2px 7px", borderRadius: "4px",
                        background: modelColor(row.model) + "22",
                        color: modelColor(row.model),
                        fontWeight: 600,
                      }}>
                        {row.model.length > 20 ? row.model.slice(0, 20) + "…" : row.model}
                      </span>
                    </td>
                    <td style={{ padding: "9px 14px", color: T.textSub }}>{row.task_type}</td>
                    <td style={{ padding: "9px 14px", color: row.symbol ? T.accent : T.border }}>
                      {row.symbol ?? "—"}
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: "'JetBrains Mono', monospace", color: T.muted }}>
                      {row.tokens_in.toLocaleString()}
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: "'JetBrains Mono', monospace", color: T.muted }}>
                      {row.tokens_out.toLocaleString()}
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: "'JetBrains Mono', monospace", color: T.green, whiteSpace: "nowrap" }}>
                      ${row.cost_usd.toFixed(5)}
                    </td>
                    <td style={{ padding: "9px 14px", fontFamily: "'JetBrains Mono', monospace", color: T.muted }}>
                      {row.duration_ms > 0 ? `${row.duration_ms}ms` : "—"}
                    </td>
                    <td style={{ padding: "9px 14px" }}>
                      {row.success ? (
                        <span style={{ color: T.green, fontSize: "13px" }}>✓</span>
                      ) : (
                        <span style={{ color: T.red, fontSize: "13px" }} title={row.error_msg ?? ""}>✗</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
