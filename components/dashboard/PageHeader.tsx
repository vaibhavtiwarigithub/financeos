"use client";
import { useState } from "react";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1", accentBg: "#1E1F3A", dim: "#13151C",
};

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  cadence?: "daily" | "weekly" | "as-needed";
  whatItDoes: string;          // one sentence — what data/content is here
  whatToLookFor: string[];     // 2-4 bullets — what the user should act on
  actions?: { label: string; onClick: () => void; primary?: boolean }[];
}

const CADENCE_META = {
  daily:    { label: "Check Daily",    color: "#34D399", bg: "#052E16" },
  weekly:   { label: "Check Weekly",   color: "#FBBF24", bg: "#2D1B00" },
  "as-needed": { label: "As Needed",   color: "#6B7280", bg: "#1A1D27" },
};

export default function PageHeader({ title, subtitle, cadence, whatItDoes, whatToLookFor, actions }: PageHeaderProps) {
  const [infoOpen, setInfoOpen] = useState(false);
  const cm = cadence ? CADENCE_META[cadence] : null;

  return (
    <div style={{ padding: "20px 28px 0" }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
            <h1 style={{ fontSize: "20px", fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>{title}</h1>
            {cm && (
              <span style={{ fontSize: "9px", fontWeight: 700, padding: "2px 7px", borderRadius: "4px", background: cm.bg, color: cm.color, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {cm.label}
              </span>
            )}
          </div>
          {subtitle && <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{subtitle}</div>}
        </div>

        {/* Actions + info toggle */}
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexShrink: 0 }}>
          {actions?.map((a, i) => (
            <button
              key={i}
              onClick={a.onClick}
              style={{
                padding: "7px 14px", borderRadius: "7px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                background: a.primary ? T.accent : "none",
                border: a.primary ? "none" : `1px solid ${T.border}`,
                color: a.primary ? "#fff" : T.textSub,
              }}
            >
              {a.label}
            </button>
          ))}
          <button
            onClick={() => setInfoOpen(o => !o)}
            title="What's on this page"
            style={{
              padding: "6px 10px", borderRadius: "7px", fontSize: "11px", fontWeight: 600, cursor: "pointer",
              background: infoOpen ? T.accentBg : "none",
              border: `1px solid ${infoOpen ? T.accent + "44" : T.border}`,
              color: infoOpen ? T.accent : T.muted,
            }}
          >
            {infoOpen ? "▲ Hide" : "? Help"}
          </button>
        </div>
      </div>

      {/* Info box (collapsible) */}
      {infoOpen && (
        <div style={{
          background: T.accentBg, border: `1px solid ${T.accent}22`,
          borderRadius: "10px", padding: "14px 16px", marginBottom: "16px",
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px",
        }}>
          <div>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>What's here</div>
            <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>{whatItDoes}</div>
          </div>
          <div>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.accent, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "6px" }}>What to look for</div>
            <ul style={{ margin: 0, padding: "0 0 0 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
              {whatToLookFor.map((item, i) => (
                <li key={i} style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.5" }}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
