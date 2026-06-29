"use client";

import { useState } from "react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", amber: "#FBBF24",
  greenBg: "#052E16", redBg: "#3B0000", amberBg: "#2D1B00",
};

// ─── Types ────────────────────────────────────────────────────────────────────

type EventKind = "agent_run" | "signal" | "paper_trade" | "learning_log";

interface TimelineEvent {
  id: string;
  kind: EventKind;
  ts: Date;
  raw: any;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function calendarKey(d: Date): string {
  // "2026-06-28"
  return d.toISOString().slice(0, 10);
}

function formatDayHeader(key: string): string {
  // key = "2026-06-28"
  const d = new Date(key + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

// ─── Event builders ───────────────────────────────────────────────────────────

function buildEvents(
  runs: any[],
  signals: any[],
  trades: any[],
  learningLog: any[],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (const r of runs) {
    const ts = toDate(r.completed_at) ?? toDate(r.created_at);
    if (!ts) continue;
    events.push({ id: `run-${r.id ?? Math.random()}`, kind: "agent_run", ts, raw: r });
  }

  for (const s of signals) {
    const ts = toDate(s.created_at);
    if (!ts) continue;
    events.push({ id: `sig-${s.id ?? Math.random()}`, kind: "signal", ts, raw: s });
  }

  for (const t of trades) {
    const ts = toDate(t.executed_at);
    if (!ts) continue;
    events.push({ id: `trade-${t.id ?? Math.random()}`, kind: "paper_trade", ts, raw: t });
  }

  for (const l of learningLog) {
    const ts = toDate(l.created_at);
    if (!ts) continue;
    events.push({ id: `log-${l.id ?? Math.random()}`, kind: "learning_log", ts, raw: l });
  }

  // Sort descending
  events.sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return events;
}

// Group by calendar day key, preserving sorted order
function groupByDay(events: TimelineEvent[]): [string, TimelineEvent[]][] {
  const map = new Map<string, TimelineEvent[]>();
  for (const ev of events) {
    const key = calendarKey(ev.ts);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(ev);
  }
  return Array.from(map.entries());
}

// ─── Event card helpers ───────────────────────────────────────────────────────

interface EventMeta {
  icon: string;
  dotColor: string;
  label: string;
  subtext: string;
}

function getEventMeta(ev: TimelineEvent): EventMeta {
  const r = ev.raw;

  if (ev.kind === "agent_run") {
    const summary = r.result_summary ?? r.status ?? "completed";
    const sigCount = r.signals_written ?? r.signals_count ?? 0;
    const symbols: string[] = Array.isArray(r.symbols) ? r.symbols : [];
    return {
      icon: "◐",
      dotColor: T.accent,
      label: `${r.agent_type ?? "Agent"} ran — ${summary}`,
      subtext: [
        sigCount > 0 ? `${sigCount} signals` : null,
        symbols.length > 0 ? symbols.join(", ") : null,
      ].filter(Boolean).join(" | "),
    };
  }

  if (ev.kind === "signal") {
    const dir = (r.direction ?? "neutral").toLowerCase();
    let icon = "→";
    let dotColor = T.amber;
    if (dir === "long" || dir === "buy") { icon = "↑"; dotColor = T.green; }
    else if (dir === "short" || dir === "sell") { icon = "↓"; dotColor = T.red; }
    const score = r.analyst_score ?? r.score ?? "—";
    return {
      icon,
      dotColor,
      label: `${r.symbol ?? "???"}: ${dir.toUpperCase()} score=${score}`,
      subtext: [
        r.conviction ? `conviction ${r.conviction}` : null,
        r.source ?? null,
      ].filter(Boolean).join(" | "),
    };
  }

  if (ev.kind === "paper_trade") {
    const side = (r.side ?? r.action ?? "BUY").toUpperCase();
    const qty = r.qty ?? r.quantity ?? r.shares ?? 1;
    const symbol = r.symbol ?? "???";
    const price = typeof r.fill_price === "number" ? r.fill_price : parseFloat(r.fill_price ?? "0");
    const priceStr = isNaN(price) ? "—" : `$${price.toFixed(2)}`;

    let subtext = "";
    if (r.closed_at && typeof r.pnl === "number") {
      const pnl = r.pnl;
      subtext = `Closed ${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toFixed(2)} P&L`;
    } else if (r.status) {
      subtext = `Status: ${r.status}`;
    }

    return {
      icon: "◈",
      dotColor: T.accent,
      label: `Paper ${side} ${qty}× ${symbol} @ ${priceStr}`,
      subtext,
    };
  }

  // learning_log
  const note = r.note ?? r.content ?? r.text ?? "";
  return {
    icon: "🧠",
    dotColor: T.amber,
    label: "Learning note",
    subtext: note.length > 100 ? note.slice(0, 100) + "…" : note,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function DayHeader({ dayKey }: { dayKey: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
      <span style={{
        fontSize: "12px",
        fontWeight: 700,
        color: T.text,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}>
        {formatDayHeader(dayKey)}
      </span>
      <div style={{ flex: 1, height: "1px", background: T.border }} />
    </div>
  );
}

function ExpandedDetails({ ev }: { ev: TimelineEvent }) {
  const raw = ev.raw;
  const style: React.CSSProperties = {
    borderTop: `1px solid ${T.border}`,
    marginTop: 12,
    paddingTop: 12,
  };

  if (ev.kind === "agent_run") {
    return (
      <div style={style}>
        <div style={{ fontSize: "12px", color: T.textSub }}>
          <div><b>Summary:</b> {raw.result_summary}</div>
          <div style={{ marginTop: 6 }}><b>Symbols:</b> {raw.symbols?.join(", ") || "—"}</div>
          <div><b>Signals written:</b> {raw.signals_written ?? 0}</div>
          <div><b>Status:</b> {raw.status}</div>
        </div>
      </div>
    );
  }

  if (ev.kind === "signal") {
    return (
      <div style={style}>
        <div style={{ fontSize: "12px", color: T.textSub }}>
          <div><b>Direction:</b> {raw.direction} | <b>Score:</b> {raw.analyst_score} | <b>Conviction:</b> {raw.conviction}</div>
          <div style={{ marginTop: 6 }}><b>Score explained:</b> Composite 0–100. ≥60 = PaperTrader fills. ≥70 = high conviction. Combines fundamentals (PE, revenue, FCF), technicals (RSI, EMA), news sentiment, insider activity, earnings revision.</div>
          {raw.rationale && <div style={{ marginTop: 6, fontStyle: "italic" }}><b>Rationale:</b> {raw.rationale}</div>}
          <div style={{ marginTop: 4 }}><b>Source:</b> {raw.source ?? "screener"} | <b>Status:</b> {raw.status}</div>
        </div>
      </div>
    );
  }

  if (ev.kind === "paper_trade") {
    return (
      <div style={style}>
        <div style={{ fontSize: "12px", color: T.textSub }}>
          <div><b>Side:</b> {raw.order_side?.toUpperCase()} | <b>Qty:</b> {raw.qty} | <b>Fill:</b> ${Number(raw.fill_price).toFixed(2)}</div>
          <div><b>Total cost:</b> ${(raw.qty * raw.fill_price).toFixed(2)}</div>
          {raw.exit_price && <div><b>Exit:</b> ${Number(raw.exit_price).toFixed(2)} | <b>P&L:</b> ${Number(raw.realized_pnl).toFixed(2)} ({raw.outcome})</div>}
          {raw.rationale && <div style={{ marginTop: 6, fontStyle: "italic", maxWidth: 600 }}><b>Rationale:</b> {raw.rationale.slice(0, 300)}{raw.rationale.length > 300 ? "…" : ""}</div>}
        </div>
      </div>
    );
  }

  // learning_log
  return (
    <div style={style}>
      <div style={{ fontSize: "12px", color: T.textSub }}>
        <div style={{ fontStyle: "italic" }}>{raw.note}</div>
        {raw.trades_evaluated != null && <div style={{ marginTop: 4 }}><b>Trades evaluated:</b> {raw.trades_evaluated}</div>}
      </div>
    </div>
  );
}

function EventCard({ ev, expandedId, setExpandedId }: {
  ev: TimelineEvent;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const meta = getEventMeta(ev);
  const isExpanded = expandedId === ev.id;

  return (
    <div style={{ display: "flex", gap: "0", alignItems: "flex-start", position: "relative" }}>
      {/* Timeline line + dot column */}
      <div style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        width: "32px",
        flexShrink: 0,
        position: "relative",
      }}>
        {/* Dot */}
        <div style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: meta.dotColor,
          border: `2px solid ${T.card}`,
          marginTop: "14px",
          zIndex: 1,
          flexShrink: 0,
        }} />
      </div>

      {/* Card content */}
      <div
        onClick={() => setExpandedId(isExpanded ? null : ev.id)}
        style={{
          flex: 1,
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: "8px",
          padding: "10px 14px",
          marginBottom: "8px",
          minWidth: 0,
          cursor: "pointer",
        }}
      >
        {/* Header row */}
        <div style={{ display: "flex", gap: "12px", alignItems: "flex-start" }}>
          {/* Icon */}
          <span style={{
            fontSize: "16px",
            lineHeight: 1,
            marginTop: "2px",
            flexShrink: 0,
            color: meta.dotColor,
            fontStyle: "normal",
          }}>
            {meta.icon}
          </span>

          {/* Text */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: "13px",
              fontWeight: 500,
              color: T.text,
              lineHeight: "1.4",
              wordBreak: "break-word",
            }}>
              {meta.label}
            </div>
            {meta.subtext && (
              <div style={{
                fontSize: "11px",
                color: T.textSub,
                marginTop: "3px",
                lineHeight: "1.4",
                wordBreak: "break-word",
              }}>
                {meta.subtext}
              </div>
            )}
          </div>

          {/* Time + toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0, marginTop: "2px" }}>
            <span style={{
              fontSize: "11px",
              color: T.muted,
              whiteSpace: "nowrap",
            }}>
              {formatTime(ev.ts)}
            </span>
            <span style={{ fontSize: "11px", color: T.muted, userSelect: "none" }}>
              {isExpanded ? "▾" : "▸"}
            </span>
          </div>
        </div>

        {/* Expanded details */}
        {isExpanded && <ExpandedDetails ev={ev} />}
      </div>
    </div>
  );
}

function DaySection({ dayKey, events, expandedId, setExpandedId }: {
  dayKey: string;
  events: TimelineEvent[];
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  return (
    <div style={{ marginBottom: "28px" }}>
      <DayHeader dayKey={dayKey} />

      {/* Events with vertical line */}
      <div style={{
        display: "flex",
        gap: "0",
        marginTop: "8px",
      }}>
        {/* Vertical line */}
        <div style={{
          width: "32px",
          flexShrink: 0,
          display: "flex",
          justifyContent: "center",
        }}>
          <div style={{
            width: "2px",
            background: T.border,
            borderRadius: "1px",
          }} />
        </div>

        {/* Event cards stacked */}
        <div style={{ flex: 1, marginLeft: "-32px" }}>
          {events.map((ev) => (
            <EventCard key={ev.id} ev={ev} expandedId={expandedId} setExpandedId={setExpandedId} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function ActivityPage({
  runs,
  signals,
  trades,
  learningLog,
}: {
  runs: any[];
  signals: any[];
  trades: any[];
  learningLog: any[];
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const events = buildEvents(runs, signals, trades, learningLog);
  const grouped = groupByDay(events);

  return (
    <div style={{
      minHeight: "100vh",
      background: T.bg,
      color: T.text,
      fontFamily: "'Inter', system-ui, sans-serif",
      padding: "32px 24px",
      maxWidth: "760px",
      margin: "0 auto",
    }}>
      {/* Page header */}
      <div style={{ marginBottom: "32px" }}>
        <h1 style={{
          fontSize: "22px",
          fontWeight: 700,
          color: T.text,
          margin: 0,
          letterSpacing: "-0.02em",
        }}>
          Activity
        </h1>
        <p style={{
          fontSize: "13px",
          color: T.textSub,
          margin: "6px 0 0 0",
        }}>
          All agent runs, signals, trades, and learning notes — newest first.
        </p>
      </div>

      {/* Empty state */}
      {events.length === 0 && (
        <div style={{
          textAlign: "center",
          padding: "80px 24px",
          color: T.muted,
        }}>
          <div style={{ fontSize: "32px", marginBottom: "16px" }}>◐</div>
          <div style={{ fontSize: "15px", fontWeight: 500, color: T.textSub }}>
            No activity yet.
          </div>
          <div style={{ fontSize: "13px", marginTop: "6px", color: T.muted }}>
            Run an agent to get started.
          </div>
        </div>
      )}

      {/* Timeline */}
      {grouped.map(([dayKey, dayEvents]) => (
        <DaySection key={dayKey} dayKey={dayKey} events={dayEvents} expandedId={expandedId} setExpandedId={setExpandedId} />
      ))}
    </div>
  );
}
