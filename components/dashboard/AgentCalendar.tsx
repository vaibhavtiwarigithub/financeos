"use client";
import { useState, useEffect } from "react";
import { useMarket } from "@/lib/market-context";

const T = {
  card: "#1A1D27", border: "#252836", surface: "#13151C",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  green: "#34D399", red: "#F87171", amber: "#FBBF24",
};

const STATUS_COLOR: Record<string, string> = {
  ok: T.green, error: T.red, partial: T.amber, skipped: T.muted, missing: "transparent",
};

interface Cell { status: string; runs: number; summary: string; trigger: string | null }
interface Day { date: string; agents: Record<string, Cell> }

export default function AgentCalendar() {
  const [days, setDays] = useState<Day[] | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [popover, setPopover] = useState<{ date: string; agent: string; cell: Cell } | null>(null);
  const { market } = useMarket();

  useEffect(() => {
    const stored = localStorage.getItem("kairos_agent_calendar_collapsed");
    if (stored != null) setCollapsed(stored === "1");
  }, []);

  // Re-fetch when opened OR when the market switch changes, so the grid shows the
  // US pipeline or the India pipeline (whichever the header switch is on).
  useEffect(() => {
    if (collapsed) return;
    setDays(null);
    fetch(`/api/agents/calendar?market=${market}`).then(r => r.json()).then(d => setDays(d.days ?? [])).catch(() => {});
  }, [collapsed, market]);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("kairos_agent_calendar_collapsed", next ? "1" : "0");
  }

  const agentNames = days ? Array.from(new Set(days.flatMap(d => Object.keys(d.agents)))).sort() : [];
  // Latest day on the LEFT, oldest on the RIGHT. API returns oldest→newest;
  // reverse a copy (never mutate state) and drive both header + body from it
  // so the day-number row and the dot rows stay column-aligned.
  const orderedDays = days ? [...days].reverse() : [];

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "14px 18px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }} onClick={toggle}>
        <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const }}>
          30-day Agent Calendar · {market === "india" ? "🇮🇳 India" : "🇺🇸 US"}
        </div>
        <span style={{ fontSize: "11px", color: T.muted }}>{collapsed ? "Expand ▾" : "Collapse ▴"}</span>
      </div>

      {!collapsed && (
        <div style={{ marginTop: "12px", overflowX: "auto" as const, WebkitOverflowScrolling: "touch" as const }}>
          {!days ? (
            <div style={{ fontSize: "12px", color: T.muted, padding: "8px 0" }}>Loading…</div>
          ) : agentNames.length === 0 ? (
            <div style={{ fontSize: "12px", color: T.muted, padding: "8px 0" }}>No agent runs recorded in the last 30 days.</div>
          ) : (
            <table style={{ borderCollapse: "collapse", fontSize: "10px" }}>
              <thead>
                <tr>
                  <td style={{ padding: "2px 8px 2px 0", color: T.muted, minWidth: "110px" }}></td>
                  {orderedDays.map(d => {
                    const dow = new Date(d.date + "T00:00:00").getDay();
                    const isWeekend = dow === 0 || dow === 6;
                    return (
                      <td key={d.date} style={{ padding: "0 2px", opacity: isWeekend ? 0.35 : 1, textAlign: "center" as const, color: T.muted, minWidth: "16px" }}>
                        {d.date.slice(8, 10)}
                      </td>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {agentNames.map(agent => (
                  <tr key={agent}>
                    <td style={{ padding: "2px 8px 2px 0", color: T.textSub, whiteSpace: "nowrap" as const }}>{agent}</td>
                    {orderedDays.map(d => {
                      const cell = d.agents[agent];
                      if (!cell) return <td key={d.date} style={{ padding: "0 2px" }}></td>;
                      const color = STATUS_COLOR[cell.status] ?? T.muted;
                      const hollow = cell.status === "missing";
                      return (
                        <td key={d.date} style={{ padding: "0 2px", textAlign: "center" as const }}>
                          <div
                            onClick={() => setPopover({ date: d.date, agent, cell })}
                            title={cell.summary}
                            style={{
                              width: "10px", height: "10px", borderRadius: "50%", margin: "0 auto", cursor: "pointer",
                              background: hollow ? "transparent" : color,
                              border: hollow ? `1.5px solid ${T.red}` : "none",
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {popover && (
        <div
          onClick={() => setPopover(null)}
          style={{ position: "fixed", inset: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", padding: "16px" }}
        >
          <div onClick={e => e.stopPropagation()} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "16px 20px", maxWidth: "360px", width: "100%" }}>
            <div style={{ fontSize: "13px", fontWeight: 700, color: T.text, marginBottom: "6px" }}>{popover.agent} — {popover.date}</div>
            <div style={{ fontSize: "12px", color: STATUS_COLOR[popover.cell.status] ?? T.muted, marginBottom: "8px", fontWeight: 600 }}>{popover.cell.status.toUpperCase()} · {popover.cell.runs} run{popover.cell.runs === 1 ? "" : "s"}{popover.cell.trigger ? ` · ${popover.cell.trigger}` : ""}</div>
            <div style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.5 }}>{popover.cell.summary || "No details recorded."}</div>
            <button onClick={() => setPopover(null)} style={{ marginTop: "12px", background: "transparent", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.textSub, padding: "5px 14px", fontSize: "12px", cursor: "pointer" }}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
