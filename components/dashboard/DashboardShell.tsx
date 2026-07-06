"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import { getMarketSupport, SUPPORT_META } from "@/lib/market-support";
import { MarketProvider, MarketSwitcher } from "@/lib/market-context";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", dim: "#0F1117",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24", blue: "#60A5FA",
};

type Alert = {
  id: string;
  severity: "info" | "warn" | "error" | "success";
  category: string;
  title: string;
  detail?: string;
  created_at: string;
};

const SEV: Record<string, { color: string; dot: string; bg: string }> = {
  error:   { color: T.red,    dot: T.red,    bg: "#3B000033" },
  warn:    { color: T.yellow, dot: T.yellow, bg: "#2D1B0033" },
  info:    { color: T.blue,   dot: T.blue,   bg: "#0F1A2E33" },
  success: { color: T.green,  dot: T.green,  bg: "#052E1633" },
};

// â"€â"€ Nav sections â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
const NAV_SECTIONS = [
  {
    label: "Daily",
    hint: "Check every trading day",
    items: [
      { href: "/dashboard",              label: "Morning Briefing", icon: "⌂", hint: "Portfolio snapshot + today's signals", alertCat: "home" },
      { href: "/dashboard/markets",      label: "Markets",          icon: "◉", hint: "Indices, sectors, VIX proxy",         alertCat: "market" },
      { href: "/dashboard/intelligence", label: "Intelligence",     icon: "◆", hint: "Agent signals + research runs",       alertCat: "cron" },
      { href: "/dashboard/scores",       label: "Score Tracker",    icon: "📈", hint: "Per-stock AI score over time with drill-down", alertCat: "" },
      { href: "/dashboard/agents",       label: "Agents",           icon: "⬡", hint: "Run agents manually, view status",    alertCat: "" },
      { href: "/dashboard/agents/history", label: "Agent History",  icon: "◷", hint: "Every agent run: what it did, result, handoff, cost, tokens — filter & delete", alertCat: "" },
      { href: "/dashboard/research-journal", label: "Research Journal", icon: "🔬", hint: "Daily funnel: why each symbol passed/failed at each stage, plus learning evolution over time", alertCat: "" },
      { href: "/dashboard/smart-money",  label: "Smart Money",      icon: "🦊", hint: "Trade queue, insider flow, multi-asset signals", alertCat: "" },
    ],
  },
  {
    label: "Weekly",
    hint: "Review on Fridays or Mondays",
    items: [
      { href: "/dashboard/live-portfolio", label: "Live Portfolio",   icon: "◉", hint: "Live Robinhood holdings, P&L, performance charts, transaction history", alertCat: "" },
      { href: "/dashboard/india",          label: "India",             icon: "🇮🇳", hint: "NSE stocks · Zerodha Kite", alertCat: "" },
      { href: "/dashboard/portfolio",  label: "Paper Portfolio",  icon: "◈", hint: "Paper positions, P&L, open trades",  alertCat: "portfolio" },
      { href: "/dashboard/risk",       label: "Risk Analytics",   icon: "⚠", hint: "Beta, VaR, sector concentration across all accounts", alertCat: "" },
      { href: "/dashboard/calendar",   label: "Earnings Calendar",icon: "▦", hint: "Upcoming earnings for watchlist",     alertCat: "earnings" },
      { href: "/dashboard/strategies",         label: "Strategies",       icon: "⬡", hint: "Fit scores (7 templates) + Algo Library (8 strategies) — two tabs", alertCat: "strategy" },
      { href: "/dashboard/scanner",            label: "Scanner",           icon: "⟐", hint: "Screen stocks by technical + fundamental conditions", alertCat: "" },
      { href: "/dashboard/backtest",           label: "Backtest",          icon: "⏮", hint: "Replay signals against historical prices — win rate, Sharpe, alpha", alertCat: "" },
      { href: "/dashboard/watchlist",  label: "Watchlist",        icon: "◎", hint: "AI-curated + manual symbols to track",alertCat: "watchlist" },
    ],
  },
  {
    label: "Learn",
    hint: "Improve your judgment",
    items: [
      { href: "/dashboard/mentor",     label: "Mentor",           icon: "🎓", hint: "Learn trading principles, get scored on your calls", alertCat: "" },
      { href: "/dashboard/journal",    label: "Decision Journal",  icon: "📓", hint: "Audit trail of every signal, fill, exit, and experiment decision", alertCat: "" },
    ],
  },
  {
    label: "Settings",
    hint: "",
    items: [
      { href: "/dashboard/settings",              label: "Settings",   icon: "⚙", hint: "App configuration", alertCat: "" },
      { href: "/dashboard/settings/automation",   label: "Automation", icon: "⏱", hint: "All scheduled jobs — times, runner (Supabase pg_cron → Vercel), next run", alertCat: "" },
    ],
  },
];

const ADMIN_ITEM = { href: "/dashboard/admin", label: "Admin", icon: "☆", hint: "API keys, vault, agent config", alertCat: "admin" };

// â"€â"€ Market status â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function getMarketStatus(): { label: string; color: string; bg: string; detail: string } {
  // Convert to ET (UTC-4 EDT / UTC-5 EST). We approximate: from mid-March to early Nov = EDT (UTC-4)
  const now = new Date();
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes();
  const month = now.getUTCMonth() + 1; // 1-12
  const day = now.getUTCDay(); // 0=Sun

  // EDT Apr—Oct roughly, EST Nov—Mar. Close enough for market status.
  const offsetH = (month >= 4 && month <= 10) ? 4 : 5; // hours behind UTC
  let etH = utcH - offsetH;
  if (etH < 0) etH += 24;
  const etMin = utcM;
  const etTotal = etH * 60 + etMin;

  const isWeekend = day === 0 || day === 6;
  const PRE  = 4 * 60;        // 4:00 AM ET
  const OPEN = 9 * 60 + 30;   // 9:30 AM ET
  const CLOSE = 16 * 60;      // 4:00 PM ET
  const AH   = 20 * 60;       // 8:00 PM ET

  if (isWeekend) return { label: "Closed", color: T.muted, bg: "#1A1D27", detail: "Markets closed — weekend" };
  if (etTotal < PRE)   return { label: "Closed",       color: T.muted,   bg: "#1A1D27",     detail: `Opens pre-market at 4:00 AM ET` };
  if (etTotal < OPEN)  return { label: "Pre-market",   color: T.yellow,  bg: "#2D1B0033",   detail: `Regular session opens at 9:30 AM ET` };
  if (etTotal < CLOSE) return { label: "Market Open",  color: T.green,   bg: "#052E1633",   detail: `NYSE/Nasdaq close at 4:00 PM ET` };
  if (etTotal < AH)    return { label: "After-hours",  color: T.blue,    bg: "#0F1A2E33",   detail: `Extended hours until 8:00 PM ET` };
  return { label: "Closed", color: T.muted, bg: "#1A1D27", detail: "Opens pre-market tomorrow at 4:00 AM ET" };
}

function useMarketClock() {
  const [tick, setTick] = useState(0);
  const [timeStr, setTimeStr] = useState("");
  useEffect(() => {
    function update() {
      const now = new Date();
      setTimeStr(now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }));
      setTick(t => t + 1);
    }
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, []);
  return { timeStr, status: getMarketStatus() };
}

const TIER_COLORS: Record<string, string> = { free: T.muted, pro: T.accent, elite: T.yellow };

function fmtAlertTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// â"€â"€ Alert detail parser — splits on " · " delimiter â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
function AlertDetail({ detail }: { detail: string }) {
  const lines = detail.split(" · ").filter(Boolean);
  if (lines.length <= 1) return <span style={{ fontSize: "11px", color: T.textSub }}>{detail}</span>;
  return (
    <div style={{ marginTop: "6px", display: "flex", flexDirection: "column", gap: "3px" }}>
      {lines.map((line, i) => (
        <div key={i} style={{ fontSize: "11px", color: i === 0 ? T.textSub : T.muted, lineHeight: "1.4" }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export default function DashboardShell({ profile, children }: { profile: Profile; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [expandedAlert, setExpandedAlert] = useState<string | null>(null);
  const [pauseState, setPauseState] = useState<{ paused: boolean; paused_at: string | null; paused_reason: string | null } | null>(null);
  const bellRef = useRef<HTMLDivElement>(null);
  const seenProposalIds = useRef<Set<string>>(new Set());
  const { timeStr, status: mktStatus } = useMarketClock();

  useEffect(() => {
    fetch("/api/alerts/stale-check").catch(() => {});
    fetch("/api/alerts")
      .then(r => r.json())
      .then(d => setAlerts(d.alerts ?? []))
      .catch(() => {});

    supabase
      .from("strategy_config")
      .select("app_paused, paused_at, paused_reason")
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) setPauseState({ paused: !!data.app_paused, paused_at: data.paused_at, paused_reason: data.paused_reason });
      }, () => {});
  }, []);

  // â"€â"€ Browser push: proposal watcher â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;

    // Request permission silently (won't prompt if already granted/denied)
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    async function checkProposals() {
      if (Notification.permission !== "granted") return;
      try {
        // trade_proposals.side, not order_side (that column is on paper_trades) —
        // this was silently 400ing on every page load, so the desktop
        // notification for pending proposals never fired.
        const { data } = await supabase
          .from("trade_proposals")
          .select("id, symbol, side, qty, limit_price, analyst_score, created_at")
          .eq("status", "pending_review")
          .order("created_at", { ascending: false })
          .limit(10);

        for (const p of data ?? []) {
          if (seenProposalIds.current.has(p.id)) continue;
          seenProposalIds.current.add(p.id);
          const n = new Notification("Kairos — Trade Proposal Ready", {
            body: `${p.side?.toUpperCase()} ${p.qty} ${p.symbol} @ $${Number(p.limit_price).toFixed(2)} · Score ${p.analyst_score} · Awaiting your approval`,
            icon: "/favicon.ico",
            tag: `proposal-${p.id}`,
            requireInteraction: true,
          });
          n.onclick = () => {
            window.focus();
            window.location.href = "/dashboard/smart-money";
          };
        }
      } catch { /* non-fatal */ }
    }

    checkProposals();
    const id = setInterval(checkProposals, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close bell dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setBellOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function dismissAlert(id: string) {
    setAlerts(a => a.filter(x => x.id !== id));
    fetch("/api/alerts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => {});
  }

  function dismissAll() {
    setAlerts([]);
    setBellOpen(false);
    fetch("/api/alerts", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ resolve_all: true }) }).catch(() => {});
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const isAdmin = ["admin", "superadmin"].includes(profile.role);
  const unreadCount = alerts.length;

  const worstSeverity = alerts.find(a => a.severity === "error") ? "error"
    : alerts.find(a => a.severity === "warn") ? "warn"
    : alerts.find(a => a.severity === "info") ? "info"
    : null;
  const bellColor = worstSeverity ? SEV[worstSeverity].dot : T.muted;

  const indiaEnabled = (profile?.market_focus ?? "US").toLowerCase().includes("india");

  return (
   <MarketProvider indiaEnabled={indiaEnabled}>
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, fontFamily: "'Inter', sans-serif", color: T.text }}>

      {/* â"€â"€ Sidebar â"€â"€ */}
      <aside style={{ width: "224px", background: T.surface, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", flexShrink: 0 }}>

        {/* Logo + bell row */}
        <div style={{ padding: "18px 16px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <div style={{ fontSize: "18px", fontWeight: 800, letterSpacing: "-0.03em" }}>
              <span style={{ color: T.accent }}>K</span>airos
            </div>
            <div style={{ fontSize: "9px", color: T.muted, marginTop: "2px", letterSpacing: "0.06em" }}>
              Right signal. Right moment.
            </div>
          </div>

          {/* Bell icon with badge */}
          <div ref={bellRef} style={{ position: "relative" }}>
            <button
              onClick={() => setBellOpen(o => !o)}
              title={`${unreadCount} alert${unreadCount !== 1 ? "s" : ""}`}
              style={{
                background: bellOpen ? T.card : "none",
                border: `1px solid ${bellOpen ? T.border : "transparent"}`,
                borderRadius: "8px", padding: "6px 8px", cursor: "pointer",
                color: unreadCount > 0 ? bellColor : T.muted, fontSize: "16px",
                position: "relative", display: "flex", alignItems: "center",
              }}
            >
              🔔
              {unreadCount > 0 && (
                <span style={{
                  position: "absolute", top: "2px", right: "2px",
                  width: "16px", height: "16px", borderRadius: "50%",
                  background: worstSeverity === "error" ? T.red : worstSeverity === "warn" ? T.yellow : T.blue,
                  color: "#000", fontSize: "9px", fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  border: `2px solid ${T.surface}`,
                }}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            {/* Alert dropdown — fixed so sidebar stacking context doesn't clip it */}
            {bellOpen && (
              <div style={{
                position: "fixed", top: "64px", left: "8px",
                width: "360px", background: T.card, border: `1px solid ${T.border}`,
                borderRadius: "12px", boxShadow: "0 12px 40px #000000AA",
                zIndex: 9999, overflow: "hidden",
              }}>
                {/* Dropdown header */}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 14px", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: "12px", fontWeight: 700, color: T.text }}>
                    Alerts {unreadCount > 0 && <span style={{ color: T.muted, fontWeight: 400 }}>({unreadCount})</span>}
                  </span>
                  {unreadCount > 0 && (
                    <button
                      onClick={dismissAll}
                      style={{ fontSize: "11px", color: T.muted, background: "none", border: `1px solid ${T.border}`, borderRadius: "5px", padding: "2px 8px", cursor: "pointer" }}
                    >
                      Dismiss all
                    </button>
                  )}
                </div>

                {/* Alert list */}
                <div style={{ maxHeight: "420px", overflowY: "auto" }}>
                  {alerts.length === 0 ? (
                    <div style={{ padding: "24px", textAlign: "center", color: T.muted, fontSize: "12px" }}>
                      No alerts · all systems normal
                    </div>
                  ) : alerts.map(a => {
                    const s = SEV[a.severity] ?? SEV.info;
                    const isExpanded = expandedAlert === a.id;
                    return (
                      <div
                        key={a.id}
                        style={{ padding: "11px 14px", borderBottom: `1px solid ${T.border}22`, background: isExpanded ? s.bg : "none" }}
                      >
                        <div style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                          {/* Severity dot */}
                          <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: s.dot, flexShrink: 0, marginTop: "4px" }} />

                          {/* Content */}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: "2px" }}>
                              <span style={{ fontSize: "9px", fontWeight: 700, color: s.color, background: s.bg, padding: "1px 5px", borderRadius: "3px", letterSpacing: "0.06em" }}>
                                {a.category.toUpperCase()}
                              </span>
                              <span style={{ fontSize: "10px", color: T.muted }}>{fmtAlertTime(a.created_at)}</span>
                            </div>
                            <div style={{ fontSize: "12px", fontWeight: 600, color: T.text, lineHeight: "1.4" }}>{a.title}</div>
                            {a.detail && (
                              <>
                                {!isExpanded && (
                                  <button
                                    onClick={() => setExpandedAlert(a.id)}
                                    style={{ fontSize: "10px", color: T.muted, background: "none", border: "none", padding: "2px 0", cursor: "pointer", textDecoration: "underline" }}
                                  >
                                    Show details
                                  </button>
                                )}
                                {isExpanded && <AlertDetail detail={a.detail} />}
                                {isExpanded && (
                                  <button
                                    onClick={() => setExpandedAlert(null)}
                                    style={{ fontSize: "10px", color: T.muted, background: "none", border: "none", padding: "3px 0 0", cursor: "pointer", textDecoration: "underline" }}
                                  >
                                    Hide
                                  </button>
                                )}
                              </>
                            )}
                          </div>

                          {/* Dismiss */}
                          <button
                            onClick={() => dismissAlert(a.id)}
                            style={{ color: T.muted, background: "none", border: "none", cursor: "pointer", fontSize: "16px", flexShrink: 0, lineHeight: 1, paddingTop: "1px" }}
                          >Ã—</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pause banner — shown in sidebar when app is paused */}
        {pauseState?.paused && (
          <div style={{
            margin: "8px 10px 0",
            background: "#2D1B0066",
            border: `1px solid ${T.yellow}55`,
            borderRadius: "8px",
            padding: "8px 10px",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <span style={{ fontSize: "13px" }}>â¸</span>
              <span style={{ fontSize: "11px", fontWeight: 700, color: T.yellow, letterSpacing: "0.06em" }}>APP PAUSED</span>
            </div>
            <div style={{ fontSize: "10px", color: T.muted, marginTop: "3px", lineHeight: "1.4" }}>
              All agents stopped · no AI calls
            </div>
            {pauseState.paused_at && (
              <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px" }}>
                Since {new Date(pauseState.paused_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </div>
            )}
            {pauseState.paused_reason && (
              <div style={{ fontSize: "10px", color: T.textSub, marginTop: "2px", fontStyle: "italic" }}>
                {pauseState.paused_reason}
              </div>
            )}
          </div>
        )}

        {/* Sectioned nav */}
        <nav style={{ flex: 1, padding: "10px 8px", overflowY: "auto" }}>
          {NAV_SECTIONS.map((section, si) => (
            <div key={section.label} style={{ marginBottom: si < NAV_SECTIONS.length - 1 ? "16px" : "0" }}>
              {/* Section label */}
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase", padding: "0 10px", marginBottom: "4px", display: "flex", alignItems: "center", gap: "6px" }}>
                {section.label}
                {section.hint && <span style={{ fontWeight: 400, letterSpacing: 0, textTransform: "none", color: T.muted + "88", fontSize: "8px" }}>· {section.hint}</span>}
              </div>

              {/* Nav items */}
              {section.items.map(item => {
                const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
                const catAlerts = item.alertCat ? alerts.filter(a => a.category === item.alertCat) : [];
                const catWorst = catAlerts.find(a => a.severity === "error") ? "error"
                  : catAlerts.find(a => a.severity === "warn") ? "warn"
                  : catAlerts.length > 0 ? "info" : null;
                const catDotColor = catWorst ? SEV[catWorst].dot : null;
                return (
                  <button
                    key={item.href}
                    onClick={() => router.push(item.href)}
                    title={item.hint}
                    style={{
                      width: "100%", display: "flex", alignItems: "center", gap: "9px",
                      padding: "8px 10px", borderRadius: "7px", border: "none",
                      background: active ? T.accent + "1A" : "none",
                      color: active ? T.accent : T.textSub,
                      fontSize: "13px", fontWeight: active ? 600 : 400,
                      cursor: "pointer", textAlign: "left", marginBottom: "1px",
                      borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent",
                    }}
                  >
                    <span style={{ fontSize: "13px", width: "16px", textAlign: "center", flexShrink: 0 }}>{item.icon}</span>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    {catDotColor && (
                      <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: catDotColor, flexShrink: 0 }} title={`${catAlerts.length} alert${catAlerts.length !== 1 ? "s" : ""}`} />
                    )}
                  </button>
                );
              })}

              {/* Admin item at end of Settings section */}
              {section.label === "Settings" && isAdmin && (
                <button
                  key={ADMIN_ITEM.href}
                  onClick={() => router.push(ADMIN_ITEM.href)}
                  title={ADMIN_ITEM.hint}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: "9px",
                    padding: "8px 10px", borderRadius: "7px", border: "none",
                    background: pathname.startsWith(ADMIN_ITEM.href) ? T.accent + "1A" : "none",
                    color: pathname.startsWith(ADMIN_ITEM.href) ? T.accent : T.textSub,
                    fontSize: "13px", fontWeight: pathname.startsWith(ADMIN_ITEM.href) ? 600 : 400,
                    cursor: "pointer", textAlign: "left", marginBottom: "1px",
                    borderLeft: pathname.startsWith(ADMIN_ITEM.href) ? `2px solid ${T.accent}` : "2px solid transparent",
                  }}
                >
                  <span style={{ fontSize: "13px", width: "16px", textAlign: "center", flexShrink: 0 }}>{ADMIN_ITEM.icon}</span>
                  {ADMIN_ITEM.label}
                </button>
              )}
            </div>
          ))}
        </nav>

        {/* User footer */}
        <div style={{ padding: "12px 14px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "9px" }}>
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" style={{ width: "30px", height: "30px", borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "30px", height: "30px", borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "12px", fontWeight: 700 }}>
                {(profile.full_name || profile.email)[0].toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "12px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {profile.full_name || profile.email.split("@")[0]}
              </div>
              <div style={{ fontSize: "9px", color: TIER_COLORS[profile.subscription_tier] ?? T.muted, textTransform: "uppercase", fontWeight: 700, letterSpacing: "0.06em" }}>
                {profile.subscription_tier}
              </div>
            </div>
          </div>
          <button onClick={signOut} style={{ width: "100%", background: "none", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.muted, padding: "6px", fontSize: "11px", cursor: "pointer" }}>
            Sign out
          </button>
        </div>
      </aside>

      {/* â"€â"€ Main content â"€â"€ */}
      <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        {/* Sticky market status bar */}
        <div style={{
          position: "sticky", top: 0, zIndex: 100,
          background: T.surface, borderBottom: `1px solid ${T.border}`,
          padding: "7px 28px", display: "flex", alignItems: "center", gap: "16px",
        }}>
          {/* Market status pill */}
          <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
            <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: mktStatus.color, flexShrink: 0 }} />
            <span style={{ fontSize: "12px", fontWeight: 700, color: mktStatus.color }}>{mktStatus.label}</span>
            <span style={{ fontSize: "11px", color: T.muted }}>· {mktStatus.detail}</span>
          </div>

          {/* Pause chip — top bar */}
          {pauseState?.paused && (
            <div style={{
              display: "flex", alignItems: "center", gap: "5px",
              background: "#2D1B0066", border: `1px solid ${T.yellow}55`,
              borderRadius: "6px", padding: "3px 10px",
            }}>
              <span style={{ fontSize: "11px" }}>â¸</span>
              <span style={{ fontSize: "11px", fontWeight: 700, color: T.yellow }}>PAUSED</span>
              {pauseState.paused_at && (
                <span style={{ fontSize: "10px", color: T.muted }}>
                  · since {new Date(pauseState.paused_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Global market switcher (US/India) — hidden unless India is enabled */}
          <MarketSwitcher />

          {/* Date + time ET */}
          <div style={{ fontSize: "11px", color: T.muted, display: "flex", gap: "10px", alignItems: "center" }}>
            <span>{new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
            <span style={{ color: T.textSub, fontVariantNumeric: "tabular-nums" }}>{timeStr} ET</span>
          </div>
        </div>
        {children}

        {/* Per-page country-support badge — single source of truth in lib/market-support.ts */}
        {(() => {
          const sup = getMarketSupport(pathname);
          const meta = SUPPORT_META[sup.level];
          return (
            <div style={{
              marginTop: "32px", paddingTop: "14px", borderTop: `1px solid ${T.border}`,
              display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap",
              fontSize: "11px", color: T.muted,
            }}>
              <span style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                padding: "3px 10px", borderRadius: "20px",
                background: `${meta.color}18`, color: meta.color,
                border: `1px solid ${meta.color}44`, fontWeight: 600, whiteSpace: "nowrap",
              }}>
                <span>{meta.flags}</span>
                <span>Country support: {meta.label}</span>
              </span>
              <span style={{ color: T.textSub }}>{sup.note}</span>
            </div>
          );
        })()}
      </main>
    </div>
   </MarketProvider>
  );
}
