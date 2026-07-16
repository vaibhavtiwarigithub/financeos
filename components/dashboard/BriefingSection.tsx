"use client";
import { useState, useEffect, useCallback, type ReactNode } from "react";
import { extractBriefingTickers } from "@/lib/briefing-tickers";
import { useMarket } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A", green: "#34D399", red: "#F87171",
  yellow: "#FBBF24", amber: "#FBBF24", purple: "#A78BFA", teal: "#2DD4BF",
  blue: "#60A5FA", orange: "#FB923C",
};

type Briefing = { id: string; date: string; session: "morning" | "evening"; content: string; model: string | null; created_at: string };
type WatchlistSymbol = { symbol: string };

function fmtDt(iso: string) {
  return new Date(iso).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Section config per session
const MORNING_SECTIONS: Record<string, { icon: string; color: string; bg: string; label: string; priority: number }> = {
  "TODAY'S FOCUS":    { icon: "🎯", color: T.blue,   bg: "#1A2540", label: "Today's Focus",    priority: 1 },
  "PORTFOLIO STATUS": { icon: "💼", color: T.green,  bg: "#152820", label: "Portfolio Status", priority: 2 },
  "RISK WATCH":       { icon: "⚠️", color: T.amber,  bg: "#2A1F0A", label: "Risk Watch",       priority: 3 },
  "ONE THING":        { icon: "⚡", color: T.accent, bg: "#1E1F3A", label: "One Thing",        priority: 4 },
};
const EVENING_SECTIONS: Record<string, { icon: string; color: string; bg: string; label: string; priority: number }> = {
  "WHAT HAPPENED":  { icon: "📊", color: T.blue,   bg: "#1A2540", label: "What Happened",  priority: 1 },
  "POSITIONS CHECK":{ icon: "💼", color: T.green,  bg: "#152820", label: "Positions Check", priority: 2 },
  "TOMORROW PREP":  { icon: "🔮", color: T.purple, bg: "#1F1A30", label: "Tomorrow Prep",  priority: 3 },
  "LEARNING":       { icon: "🧠", color: T.teal,   bg: "#0F2420", label: "Learning",       priority: 4 },
};

function parseSections(content: string, session: "morning" | "evening"): { key: string; title: string; body: string; config: typeof MORNING_SECTIONS[string] }[] {
  const map = session === "morning" ? MORNING_SECTIONS : EVENING_SECTIONS;
  // Split on numbered section headers: **1. SECTION NAME** or **SECTION NAME**
  const parts = content.split(/\*\*\d+\.\s+([A-Z][A-Z\s']+)\*\*/g);
  const sections: { key: string; title: string; body: string; config: typeof MORNING_SECTIONS[string] }[] = [];

  for (let i = 1; i < parts.length; i += 2) {
    const rawTitle = parts[i].trim();
    const body = (parts[i + 1] ?? "").trim();
    // Find matching config key
    const configKey = Object.keys(map).find(k => rawTitle.includes(k) || k.includes(rawTitle)) ?? rawTitle;
    const config = map[configKey] ?? { icon: "•", color: T.textSub, bg: T.card, label: rawTitle, priority: 99 };
    sections.push({ key: configKey, title: rawTitle, body, config });
  }

  // Fallback: if parsing found nothing, treat whole content as one block
  if (sections.length === 0 && content.trim()) {
    sections.push({ key: "content", title: "Briefing", body: content.trim(), config: { icon: "☀", color: T.yellow, bg: T.card, label: "Briefing", priority: 1 } });
  }

  return sections;
}

// Render content: bold, bullets, highlight numbers
function renderBody(text: string): ReactNode[] {
  const lines = text.split("\n").filter(l => l.trim());
  return lines.map((line, i) => {
    const trimmed = line.trim();
    const isBullet = trimmed.startsWith("•") || trimmed.startsWith("-") || trimmed.startsWith("*");
    const content = isBullet ? trimmed.replace(/^[•\-\*]\s*/, "") : trimmed;
    const nodes = renderInline(content);

    if (isBullet) {
      return (
        <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "5px", alignItems: "flex-start" }}>
          <span style={{ color: T.muted, marginTop: "2px", flexShrink: 0, fontSize: "10px" }}>▸</span>
          <span style={{ fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>{nodes}</span>
        </div>
      );
    }
    return <p key={i} style={{ margin: "0 0 8px", fontSize: "13px", color: T.textSub, lineHeight: "1.7" }}>{nodes}</p>;
  });
}

function renderInline(text: string): ReactNode[] {
  // Split on **bold** and highlight numbers/percentages/dollars
  const parts = text.split(/(\*\*[^*]+\*\*|\$[\d,]+\.?\d*|[+-]?\d+\.?\d*%|\$[\d.]+[kKmMbB]?)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i} style={{ color: T.text, fontWeight: 700 }}>{part.slice(2, -2)}</strong>;
    }
    // Dollar amount or percentage
    if (/^\$[\d,]+/.test(part) || /^[+-]?\d+\.?\d*%$/.test(part)) {
      const isNeg = part.startsWith("-");
      const isPos = part.startsWith("+");
      const color = isNeg ? T.red : isPos ? T.green : T.yellow;
      return <span key={i} style={{ color, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{part}</span>;
    }
    return <span key={i}>{part}</span>;
  });
}

type Props = { initialBriefing?: { id: string; date: string; session: string; content: string; model: string | null; created_at: string } | null }

export default function BriefingSection({ initialBriefing }: Props) {
  // Briefings are per-market; the server hero passes the `mkt`-scoped one in, so
  // this client refetch has to be scoped the same way or it re-introduces the
  // other market's briefing on mount.
  const { market } = useMarket();
  const [briefings, setBriefings] = useState<Briefing[]>([]);
  const [watchlist, setWatchlist] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState<"morning" | "evening" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addedNow, setAddedNow] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<"morning" | "evening" | null>("morning");

  const load = useCallback(async () => {
    setLoading(true);
    const [briefRes, watchRes] = await Promise.allSettled([
      fetch(`/api/briefing?market=${market}`).then(r => r.json()),
      fetch("/api/watchlist").then(r => r.json()),
    ]);
    if (briefRes.status === "fulfilled") setBriefings(briefRes.value.briefings ?? []);
    if (watchRes.status === "fulfilled") {
      const syms = (watchRes.value.items ?? []).map((i: WatchlistSymbol) => i.symbol);
      setWatchlist(new Set(syms));
    }
    setLoading(false);
  }, [market]);

  // Re-runs on market switch (load depends on market), so the panel follows the
  // global US/India toggle instead of keeping the first market's briefing.
  useEffect(() => { load(); }, [load]);

  async function generate(session: "morning" | "evening") {
    setGenerating(session);
    setError(null);
    const r = await fetch("/api/briefing/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    }).catch(() => null);
    if (!r?.ok) {
      const msg = await r?.text().catch(() => "Unknown error") ?? "Unknown error";
      setError(msg);
    } else {
      await load();
      setExpanded(session);
    }
    setGenerating(null);
  }

  async function addToWatchlist(symbol: string) {
    setAddedNow(prev => new Set([...prev, symbol]));
    setWatchlist(prev => new Set([...prev, symbol]));
    await fetch("/api/watchlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, source: "briefing", notes: "Mentioned in briefing" }),
    }).catch(() => {});
  }

  const morning = briefings.find(b => b.session === "morning");
  const evening = briefings.find(b => b.session === "evening");
  // Local calendar day (not UTC) so "today's briefing" matches the user's day near midnight.
  const _n = new Date();
  const todayStr = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, "0")}-${String(_n.getDate()).padStart(2, "0")}`;
  const morningIsToday = morning?.date === todayStr;
  const eveningIsToday = evening?.date === todayStr;

  const todayText = [morning?.content, evening?.content].filter(Boolean).join(" ");
  const mentionedSymbols = todayText ? extractBriefingTickers(todayText, watchlist) : [];
  const untracked = mentionedSymbols.filter(s => !watchlist.has(s));

  if (loading) {
    return (
      <div>
        <SectionLabel />
        <div style={{ color: T.muted, fontSize: "13px", padding: "40px 0", textAlign: "center" }}>Loading briefings…</div>
      </div>
    );
  }

  return (
    <div>
      <SectionLabel />

      {error && (
        <div style={{ background: "#3B0000", border: "1px solid #F8717144", borderRadius: "8px", padding: "12px 16px", marginBottom: "16px", fontSize: "12px", color: T.red }}>
          {error}
        </div>
      )}

      {briefings.length === 0 ? (
        <EmptyState generating={generating} onGenerate={generate} />
      ) : (
        <>
          {/* Tab bar */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "20px", flexWrap: "wrap" }}>
            <TabButton
              active={expanded === "morning"}
              onClick={() => setExpanded(expanded === "morning" ? null : "morning")}
              icon="☀"
              label="Morning Brief"
              isToday={morningIsToday}
              date={morning?.date}
              color={T.yellow}
              generating={generating === "morning"}
              onRegen={(e) => { e.stopPropagation(); generate("morning"); }}
              regenLabel={morningIsToday ? "Regen" : "Generate"}
              disabled={!!generating}
            />
            <TabButton
              active={expanded === "evening"}
              onClick={() => setExpanded(expanded === "evening" ? null : "evening")}
              icon="🌙"
              label="Evening Summary"
              isToday={eveningIsToday}
              date={evening?.date}
              color={T.accent}
              generating={generating === "evening"}
              onRegen={(e) => { e.stopPropagation(); generate("evening"); }}
              regenLabel={eveningIsToday ? "Regen" : "Generate"}
              disabled={!!generating}
            />
          </div>

          {/* Morning content */}
          {expanded === "morning" && (
            <BriefingContent briefing={morning ?? null} session="morning" isToday={morningIsToday} />
          )}

          {/* Evening content */}
          {expanded === "evening" && (
            <BriefingContent briefing={evening ?? null} session="evening" isToday={eveningIsToday} />
          )}

          {/* Mentioned tickers */}
          {mentionedSymbols.length > 0 && (
            <div style={{ marginTop: "16px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "14px 18px" }}>
              <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "10px" }}>
                Symbols Mentioned
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {mentionedSymbols.map(sym => {
                  const inList = watchlist.has(sym);
                  const justAdded = addedNow.has(sym);
                  return (
                    <div key={sym} style={{
                      display: "flex", alignItems: "center", gap: "5px",
                      background: inList ? `${T.green}12` : T.surface,
                      border: `1px solid ${inList ? T.green + "44" : T.border}`,
                      borderRadius: "6px", padding: "4px 8px",
                    }}>
                      <span style={{ fontSize: "11px", fontWeight: 700, color: inList ? T.green : T.text }}>{sym}</span>
                      {inList ? (
                        <span style={{ fontSize: "9px", color: T.green, fontWeight: 600 }}>{justAdded ? "Added!" : "✓"}</span>
                      ) : (
                        <button onClick={() => addToWatchlist(sym)} style={{
                          background: `${T.accent}20`, border: `1px solid ${T.accent}44`,
                          color: T.accent, borderRadius: "3px", padding: "1px 6px",
                          fontSize: "9px", fontWeight: 700, cursor: "pointer",
                        }}>+ Watch</button>
                      )}
                    </div>
                  );
                })}
                {untracked.length === 0 && <span style={{ fontSize: "11px", color: T.green }}>All symbols watched ✓</span>}
              </div>
            </div>
          )}

          {/* Collapsible history */}
          {briefings.length > 2 && (
            <PastBriefings briefings={briefings.slice(2)} onDeleted={load} />
          )}
        </>
      )}
    </div>
  );
}

function SectionLabel() {
  return <div style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: "14px" }}>Daily Briefing</div>;
}

function TabButton({ active, onClick, icon, label, isToday, date, color, generating, onRegen, regenLabel, disabled }: {
  active: boolean; onClick: () => void; icon: string; label: string; isToday: boolean;
  date?: string; color: string; generating: boolean; onRegen: (e: React.MouseEvent) => void;
  regenLabel: string; disabled: boolean;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        flex: 1, background: active ? T.card : T.surface,
        border: `1px solid ${active ? color + "44" : T.border}`,
        borderRadius: "10px", padding: "10px 14px", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        transition: "border-color 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "16px" }}>{icon}</span>
        <div>
          <div style={{ fontSize: "12px", fontWeight: 700, color: active ? color : T.textSub }}>{label}</div>
          {date && <div style={{ fontSize: "10px", color: T.muted }}>{isToday ? "Today" : date}</div>}
          {!date && <div style={{ fontSize: "10px", color: T.muted }}>Not generated yet</div>}
        </div>
      </div>
      <button
        onClick={onRegen}
        disabled={disabled}
        style={{
          fontSize: "10px", padding: "3px 8px", borderRadius: "5px",
          border: `1px solid ${T.border}`, background: "none",
          color: generating ? color : T.muted, cursor: "pointer",
          opacity: disabled ? 0.5 : 1, fontWeight: generating ? 700 : 400,
        }}
      >
        {generating ? "…" : regenLabel}
      </button>
    </div>
  );
}

function BriefingContent({ briefing, session, isToday }: { briefing: Briefing | null; session: "morning" | "evening"; isToday: boolean }) {
  if (!briefing) {
    return (
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "32px", textAlign: "center" }}>
        <div style={{ fontSize: "28px", marginBottom: "10px" }}>{session === "morning" ? "☀" : "🌙"}</div>
        <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "6px" }}>No {session} briefing yet</div>
        <div style={{ fontSize: "12px", color: T.muted }}>
          Auto-generates at {session === "morning" ? "8:55 AM" : "4:45 PM"} ET weekdays
        </div>
      </div>
    );
  }

  const sections = parseSections(briefing.content, session);
  const hasRisk = sections.find(s => s.key === "RISK WATCH" || s.key === "POSITIONS CHECK");
  const hasOneThing = sections.find(s => s.key === "ONE THING");

  return (
    <div>
      {/* Timestamp bar */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
        <span style={{ fontSize: "10px", color: T.muted }}>{fmtDt(briefing.created_at)}</span>
        {isToday && <span style={{ fontSize: "9px", fontWeight: 700, color: T.green, background: `${T.green}18`, border: `1px solid ${T.green}33`, borderRadius: "4px", padding: "1px 6px" }}>LIVE</span>}
        {briefing.model && <span style={{ fontSize: "9px", color: T.muted }}>· {briefing.model}</span>}
      </div>

      {/* ONE THING — always show first if present, as hero banner */}
      {hasOneThing && (
        <div style={{
          background: "linear-gradient(135deg, #1E1F3A 0%, #252863 100%)",
          border: `1px solid ${T.accent}55`, borderRadius: "12px", padding: "16px 20px", marginBottom: "14px",
          display: "flex", alignItems: "flex-start", gap: "12px",
        }}>
          <span style={{ fontSize: "20px", lineHeight: 1 }}>⚡</span>
          <div>
            <div style={{ fontSize: "10px", fontWeight: 800, color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "5px" }}>One Thing Today</div>
            <div style={{ fontSize: "14px", color: T.text, lineHeight: "1.6", fontWeight: 500 }}>
              {renderBody(hasOneThing.body)}
            </div>
          </div>
        </div>
      )}

      {/* Risk Watch — elevated prominence if present */}
      {hasRisk && (
        <div style={{
          background: "#1F1500", border: `1px solid ${T.amber}44`, borderRadius: "12px",
          padding: "14px 18px", marginBottom: "14px",
          display: "flex", gap: "12px", alignItems: "flex-start",
        }}>
          <span style={{ fontSize: "18px", lineHeight: 1, marginTop: "1px" }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: "10px", fontWeight: 800, color: T.amber, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>{hasRisk.config.label}</div>
            {renderBody(hasRisk.body)}
          </div>
        </div>
      )}

      {/* Remaining sections as grid cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "12px" }}>
        {sections
          .filter(s => s.key !== "ONE THING" && s.key !== "RISK WATCH" && s.key !== "POSITIONS CHECK")
          .map((section) => (
            <SectionCard key={section.key} section={section} />
          ))}
      </div>
    </div>
  );
}

function SectionCard({ section }: { section: { key: string; title: string; body: string; config: { icon: string; color: string; bg: string; label: string; priority: number } } }) {
  return (
    <div style={{
      background: section.config.bg,
      border: `1px solid ${section.config.color}33`,
      borderRadius: "12px", padding: "16px 18px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" }}>
        <span style={{ fontSize: "16px", lineHeight: 1 }}>{section.config.icon}</span>
        <span style={{ fontSize: "10px", fontWeight: 800, color: section.config.color, letterSpacing: "0.1em", textTransform: "uppercase" }}>
          {section.config.label}
        </span>
      </div>
      <div>{renderBody(section.body)}</div>
    </div>
  );
}

function PastBriefings({ briefings, onDeleted }: { briefings: Briefing[]; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [deletingAll, setDeletingAll] = useState(false);

  async function deleteAll() {
    if (!confirm(`Delete all ${briefings.length} past briefings? This cannot be undone.`)) return;
    setDeletingAll(true);
    await Promise.all(briefings.map(b =>
      fetch(`/api/briefing?id=${b.id}`, { method: "DELETE" }).catch(() => {})
    ));
    setDeletingAll(false);
    onDeleted();
  }

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", padding: "8px 0" }}
        onClick={() => setOpen(o => !o)}>
        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
          <span style={{ fontSize: "10px", color: T.muted, transition: "transform 0.15s", display: "inline-block", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
          <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Past Briefings ({briefings.length})
          </span>
        </div>
        {open && (
          <button onClick={e => { e.stopPropagation(); deleteAll(); }} disabled={deletingAll}
            style={{ fontSize: "10px", color: T.red, background: `${T.red}12`, border: `1px solid ${T.red}33`, borderRadius: "5px", padding: "3px 10px", cursor: "pointer", opacity: deletingAll ? 0.5 : 1 }}>
            {deletingAll ? "Deleting…" : "Delete All"}
          </button>
        )}
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {briefings.map(b => (
            <div key={b.id} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "10px 14px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                <span style={{ fontSize: "11px", fontWeight: 600, color: b.session === "morning" ? T.yellow : T.accent }}>
                  {b.session === "morning" ? "☀ Morning" : "🌙 Evening"} · {b.date}
                </span>
                <span style={{ fontSize: "10px", color: T.muted }}>{new Date(b.created_at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div style={{ fontSize: "12px", color: T.muted, lineHeight: "1.6" }}>{b.content.slice(0, 180)}…</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ generating, onGenerate }: { generating: "morning" | "evening" | null; onGenerate: (s: "morning" | "evening") => void }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center" }}>
      <div style={{ fontSize: "32px", marginBottom: "12px" }}>☀</div>
      <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "6px" }}>No briefings yet</div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: "20px" }}>
        Auto-generates at 8:55 AM (morning) and 4:45 PM (evening) ET weekdays.
      </div>
      <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
        <button onClick={() => onGenerate("morning")} disabled={!!generating} style={{
          padding: "9px 22px", borderRadius: "8px", background: T.accent, border: "none",
          color: "#fff", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: generating ? 0.6 : 1,
        }}>
          {generating === "morning" ? "Generating…" : "Generate Morning Brief"}
        </button>
        <button onClick={() => onGenerate("evening")} disabled={!!generating} style={{
          padding: "9px 22px", borderRadius: "8px", background: "none",
          border: `1px solid ${T.border}`, color: T.textSub, fontSize: "13px",
          fontWeight: 600, cursor: "pointer", opacity: generating ? 0.6 : 1,
        }}>
          {generating === "evening" ? "Generating…" : "Generate Evening Summary"}
        </button>
      </div>
    </div>
  );
}
