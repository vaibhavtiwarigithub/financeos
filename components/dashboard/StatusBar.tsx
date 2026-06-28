"use client";
import { useEffect, useState } from "react";

function getET() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

type MarketState = "PRE-MARKET" | "OPEN" | "AFTER-HOURS" | "CLOSED";

function getMarketState(et: Date): { state: MarketState; color: string; nextLabel: string; nextMs: number } {
  const day = et.getDay(); // 0=Sun, 6=Sat
  const h = et.getHours();
  const m = et.getMinutes();
  const mins = h * 60 + m;

  const isWeekend = day === 0 || day === 6;

  if (isWeekend) {
    // Next open: Monday 4:00 AM ET
    const daysUntilMon = day === 6 ? 2 : 1;
    const nextOpen = new Date(et);
    nextOpen.setDate(nextOpen.getDate() + daysUntilMon);
    nextOpen.setHours(4, 0, 0, 0);
    return { state: "CLOSED", color: "#6B7280", nextLabel: "Opens Mon", nextMs: nextOpen.getTime() - et.getTime() };
  }

  // Weekday
  if (mins < 240) { // before 4:00 AM
    const nextOpen = new Date(et); nextOpen.setHours(4, 0, 0, 0);
    return { state: "CLOSED", color: "#6B7280", nextLabel: "Pre-mkt in", nextMs: nextOpen.getTime() - et.getTime() };
  }
  if (mins < 570) { // 4:00–9:30 AM
    const nextOpen = new Date(et); nextOpen.setHours(9, 30, 0, 0);
    return { state: "PRE-MARKET", color: "#F59E0B", nextLabel: "Open in", nextMs: nextOpen.getTime() - et.getTime() };
  }
  if (mins < 960) { // 9:30 AM–4:00 PM
    const close = new Date(et); close.setHours(16, 0, 0, 0);
    return { state: "OPEN", color: "#34D399", nextLabel: "Closes in", nextMs: close.getTime() - et.getTime() };
  }
  if (mins < 1200) { // 4:00–8:00 PM
    const close = new Date(et); close.setHours(20, 0, 0, 0);
    return { state: "AFTER-HOURS", color: "#818CF8", nextLabel: "Closes in", nextMs: close.getTime() - et.getTime() };
  }
  // After 8:00 PM — next day pre-market
  const nextOpen = new Date(et);
  nextOpen.setDate(nextOpen.getDate() + (day === 5 ? 3 : 1)); // Friday → Monday
  nextOpen.setHours(4, 0, 0, 0);
  return { state: "CLOSED", color: "#6B7280", nextLabel: "Pre-mkt in", nextMs: nextOpen.getTime() - et.getTime() };
}

function fmtCountdown(ms: number) {
  if (ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function StatusBar() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!now) return null;

  const et = getET();
  const { state, color, nextLabel, nextMs } = getMarketState(et);

  const etStr = et.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });
  const dateStr = et.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        height: "32px",
        background: "#0F1117",
        borderTop: "1px solid #1E2130",
        display: "flex",
        alignItems: "center",
        paddingLeft: "232px", // clear sidebar
        paddingRight: "20px",
        gap: "24px",
        zIndex: 50,
        fontSize: "11px",
        color: "#6B7280",
        fontFamily: "'Inter', system-ui, sans-serif",
        userSelect: "none",
      }}
    >
      {/* Market status */}
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, display: "inline-block",
          boxShadow: state === "OPEN" ? `0 0 6px ${color}` : "none" }} />
        <span style={{ color, fontWeight: 600, letterSpacing: "0.05em" }}>{state}</span>
        <span style={{ color: "#4B5563" }}>·</span>
        <span>{nextLabel} <span style={{ color: "#9CA3AF" }}>{fmtCountdown(nextMs)}</span></span>
      </div>

      <span style={{ color: "#2D3448" }}>|</span>

      {/* ET Clock */}
      <div>
        <span style={{ color: "#9CA3AF" }}>{dateStr}</span>
        <span style={{ color: "#4B5563" }}> · </span>
        <span style={{ color: "#9CA3AF", fontVariantNumeric: "tabular-nums" }}>{etStr} ET</span>
      </div>

      <span style={{ color: "#2D3448" }}>|</span>

      {/* Local time */}
      <div style={{ color: "#4B5563" }}>
        {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} local
      </div>
    </div>
  );
}
