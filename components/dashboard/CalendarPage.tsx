"use client";
import { useEffect, useState } from "react";

const WATCHLIST = ["AAPL", "NVDA", "TSLA", "MSFT", "META", "GOOGL", "AMZN", "SPY"];

type EarningsEvent = {
  symbol: string;
  name: string;
  reportDate: string;
  timing: "am" | "pm" | "";
  epsEstimate: string;
  epsActual: string | null;
  quarter: string;
};

type EconEvent = {
  date: string;
  name: string;
  impact: "high" | "medium" | "low";
  country: string;
  previous?: string;
  forecast?: string;
};

// Key economic events hardcoded (updated periodically — add ALPHA_VANTAGE_API_KEY to .env.local for live data)
const ECON_EVENTS: EconEvent[] = [
  { date: "2026-07-01", name: "ISM Manufacturing PMI", impact: "high", country: "US" },
  { date: "2026-07-03", name: "Nonfarm Payrolls", impact: "high", country: "US" },
  { date: "2026-07-03", name: "Unemployment Rate", impact: "high", country: "US" },
  { date: "2026-07-10", name: "CPI (YoY)", impact: "high", country: "US" },
  { date: "2026-07-15", name: "Fed Beige Book", impact: "medium", country: "US" },
  { date: "2026-07-17", name: "Retail Sales", impact: "high", country: "US" },
  { date: "2026-07-29", name: "FOMC Rate Decision", impact: "high", country: "US" },
  { date: "2026-07-30", name: "GDP (Advance)", impact: "high", country: "US" },
];

function impactColor(impact: string) {
  return impact === "high" ? "#F87171" : impact === "medium" ? "#F59E0B" : "#6B7280";
}

function daysFromNow(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86400000);
}

function fmtDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric", weekday: "short" });
}

function DaysChip({ days }: { days: number }) {
  const label = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days < 0 ? `${Math.abs(days)}d ago` : `in ${days}d`;
  const color = days < 0 ? "#4B5563" : days <= 1 ? "#F87171" : days <= 5 ? "#F59E0B" : "#6B7280";
  return (
    <span style={{ fontSize: "10px", color, background: `${color}18`, padding: "1px 6px", borderRadius: "4px", fontWeight: 600 }}>
      {label}
    </span>
  );
}

export default function CalendarPage() {
  const [earnings, setEarnings] = useState<EarningsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [slowFetch, setSlowFetch] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [source, setSource] = useState<string>("");
  const [tab, setTab] = useState<"earnings" | "econ">("earnings");

  async function loadEarnings() {
    try {
      const res = await fetch("/api/calendar/earnings");
      if (res.ok) {
        const data = await res.json();
        setEarnings(data.earnings ?? []);
        setSource(data.source ?? "");
      }
    } catch {}
  }

  useEffect(() => {
    const slowTimer = setTimeout(() => setSlowFetch(true), 10_000);
    loadEarnings().finally(() => {
      clearTimeout(slowTimer);
      setLoading(false);
      setSlowFetch(false);
    });
    return () => clearTimeout(slowTimer);
  }, []);

  async function refresh() {
    setRefreshing(true);
    await fetch("/api/calendar/earnings?bust=" + Date.now());
    await loadEarnings();
    setRefreshing(false);
  }

  const upcomingEcon = ECON_EVENTS
    .map(e => ({ ...e, days: daysFromNow(e.date) }))
    .filter(e => e.days >= -3)
    .sort((a, b) => a.days - b.days);

  const T = {
    bg: "#0F1117", surface: "#13151F", border: "#1E2130",
    text: "#ECEDEF", muted: "#6B7280", accent: "#6366F1",
  };

  return (
    <div style={{ padding: "28px", minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Header */}
      <div style={{ marginBottom: "24px", display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "22px", fontWeight: 700, marginBottom: "4px" }}>Calendar</div>
          <div style={{ fontSize: "13px", color: T.muted }}>
            Earnings releases & macro events
            {source && <span style={{ marginLeft: "8px", fontSize: "10px", color: "#4B5563" }}>· via Robinhood {source === "fallback" ? "(fallback)" : source === "cache" ? "(cached)" : "(live)"}</span>}
          </div>
        </div>
        <button onClick={refresh} disabled={refreshing} style={{
          padding: "6px 14px", borderRadius: "6px", border: `1px solid ${T.border}`, background: "transparent",
          color: T.muted, fontSize: "12px", cursor: "pointer", opacity: refreshing ? 0.5 : 1,
        }}>
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "4px", marginBottom: "20px", background: T.surface, borderRadius: "8px", padding: "4px", width: "fit-content", border: `1px solid ${T.border}` }}>
        {(["earnings", "econ"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "6px 16px", borderRadius: "6px", border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 500,
            background: tab === t ? T.accent : "transparent",
            color: tab === t ? "#fff" : T.muted,
            transition: "all 0.15s",
          }}>
            {t === "earnings" ? "Earnings" : "Economic Events"}
          </button>
        ))}
      </div>

      {tab === "earnings" && (
        <div>
          {loading ? (
            <div style={{ color: T.muted, fontSize: "13px" }}>
              Loading earnings…{slowFetch && " (fetching via AI subprocess, may take up to 90s…)"}
            </div>
          ) : earnings.length === 0 ? (
            <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "40px", textAlign: "center", color: T.muted, fontSize: "14px" }}>
              No upcoming earnings found for watchlist
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {earnings.map((e, i) => {
                const days = daysFromNow(e.reportDate);
                const timingLabel = e.timing === "am" ? "Before Open" : e.timing === "pm" ? "After Close" : "";
                return (
                  <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", display: "flex", alignItems: "center", gap: "16px" }}>
                    <div style={{ width: "64px", flexShrink: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: "14px", color: T.accent }}>{e.symbol}</div>
                      <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px" }}>{e.quarter}</div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "13px", fontWeight: 500 }}>{e.name || e.symbol}</div>
                      <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
                        {timingLabel && <span>{timingLabel} · </span>}
                        Est. EPS: <span style={{ color: "#9CA3AF" }}>{e.epsEstimate ? `$${e.epsEstimate}` : "—"}</span>
                        {e.epsActual && <span> · Actual: <span style={{ color: "#34D399" }}>${e.epsActual}</span></span>}
                      </div>
                    </div>
                    <div style={{ textAlign: "right", flexShrink: 0 }}>
                      <div style={{ fontSize: "12px", color: T.muted, marginBottom: "3px" }}>{fmtDate(e.reportDate)}</div>
                      <DaysChip days={days} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "econ" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {upcomingEcon.map((e, i) => (
            <div key={i} style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", padding: "14px 18px", display: "flex", alignItems: "center", gap: "16px" }}>
              <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: impactColor(e.impact), flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "13px", fontWeight: 500 }}>{e.name}</div>
                <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>
                  {e.country} · {e.impact.toUpperCase()} IMPACT
                  {e.forecast && ` · Forecast: ${e.forecast}`}
                  {e.previous && ` · Prior: ${e.previous}`}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: "12px", color: T.muted, marginBottom: "3px" }}>{fmtDate(e.date)}</div>
                <DaysChip days={e.days} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
