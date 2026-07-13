"use client";
import { useState, type ReactNode } from "react";

// Shared presentational chrome for the Live Portfolio views (US + India).
// Purely layout — no data fetching, no market logic. Both markets pass their
// own title/badge/syncLine/toolbar and their market-specific body as children,
// so US and India render an identical header + toolbar frame. Optional `help`
// (+ `cadence`) renders the same collapsible "What's here / What to look for"
// panel PageHeader carried, so unifying the chrome never drops that guidance.
const T = {
  bg: "#0D0F14", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", accentBg: "#1E1F3A",
};

const CADENCE_META = {
  daily: { label: "Check Daily", color: "#34D399", bg: "#052E16" },
  weekly: { label: "Check Weekly", color: "#FBBF24", bg: "#2D1B00" },
  "as-needed": { label: "As Needed", color: "#6B7280", bg: "#1A1D27" },
} as const;

export default function LivePortfolioShell({
  title,
  subtitle,
  badge,
  syncLine,
  toolbar,
  cadence,
  help,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  badge?: ReactNode;
  syncLine?: ReactNode;
  toolbar?: ReactNode;
  cadence?: "daily" | "weekly" | "as-needed";
  help?: { whatItDoes: string; whatToLookFor: string[] };
  children: ReactNode;
}) {
  const [helpOpen, setHelpOpen] = useState(false);
  const cm = cadence ? CADENCE_META[cadence] : null;

  return (
    <div style={{ color: T.text, fontFamily: "'Inter', sans-serif", minHeight: "100vh", background: T.bg }}>
      <div style={{ padding: "clamp(12px, 4vw, 28px)", maxWidth: "1400px" }}>

        {/* Header block (identical treatment for every market) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: help && helpOpen ? "12px" : "24px", flexWrap: "wrap", gap: "12px" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px", flexWrap: "wrap" }}>
              <h1 style={{ fontSize: "22px", fontWeight: 700, margin: 0 }}>{title}</h1>
              {badge}
              {cm && (
                <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: cm.bg, color: cm.color, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                  {cm.label}
                </span>
              )}
            </div>
            {subtitle && <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{subtitle}</div>}
            {syncLine}
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
            {toolbar}
            {help && (
              <button
                onClick={() => setHelpOpen(o => !o)}
                title="What's on this page"
                style={{
                  padding: "6px 10px", borderRadius: "7px", fontSize: "11px", fontWeight: 600, cursor: "pointer",
                  background: helpOpen ? T.accentBg : "none",
                  border: `1px solid ${helpOpen ? T.accent + "44" : T.border}`,
                  color: helpOpen ? T.accent : T.muted,
                }}
              >
                {helpOpen ? "▲ Hide" : "? Help"}
              </button>
            )}
          </div>
        </div>

        {/* Collapsible help panel (What's here / What to look for) */}
        {help && helpOpen && (
          <div style={{
            background: T.accentBg, border: `1px solid ${T.accent}22`, borderRadius: "10px",
            padding: "14px 16px", marginBottom: "20px",
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px",
          }}>
            <div>
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>What&apos;s here</div>
              <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{help.whatItDoes}</div>
            </div>
            <div>
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>What to look for</div>
              <ul style={{ margin: 0, padding: "0 0 0 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
                {help.whatToLookFor.map((item, i) => (
                  <li key={i} style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5" }}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {children}
      </div>
    </div>
  );
}
