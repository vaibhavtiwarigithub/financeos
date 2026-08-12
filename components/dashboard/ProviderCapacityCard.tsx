"use client";
// Compact capacity summary for the dashboard home page.
// Shows today's bottleneck provider + top callers with usage bars.
// Links to Settings → Data for the full 36-day heatmap.
import { useState, useEffect } from "react";

const T = {
  card: "#1A1D27", border: "#252836", surface: "#13151C",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
  amberBg: "#2D1B00",
};

function bar(pct: number | null) {
  const fill = pct == null ? T.muted : pct >= 90 ? T.red : pct >= 60 ? T.amber : T.green;
  return (
    <div style={{ flex: 1, height: "5px", background: T.surface, borderRadius: "3px", overflow: "hidden", minWidth: "48px" }}>
      <div style={{ height: "100%", width: `${Math.min(pct ?? 0, 100)}%`, background: fill, borderRadius: "3px", transition: "width 0.4s" }} />
    </div>
  );
}

export default function ProviderCapacityCard() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch("/api/data-providers")
      .then(r => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) return null;

  const { providers = [], bottleneck } = data;
  // Top 5 by todayCalls (something to show even for rate-limited providers)
  const top = [...providers]
    .sort((a: any, b: any) => (b.todayCalls ?? 0) - (a.todayCalls ?? 0))
    .slice(0, 5);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 20px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
        <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, letterSpacing: "0.12em", textTransform: "uppercase" }}>
          API Capacity
        </span>
        <a href="/dashboard/settings?tab=data" style={{ fontSize: "11px", color: T.accent, textDecoration: "none" }}>
          36-day heatmap →
        </a>
      </div>

      {bottleneck && (
        <div style={{ background: T.amberBg, borderRadius: "6px", padding: "7px 11px", marginBottom: "12px", fontSize: "12px", color: T.amber, display: "flex", alignItems: "center", gap: "6px" }}>
          <span>⚠</span>
          <span>Bottleneck: <strong>{bottleneck.label}</strong> at {bottleneck.pctUsed}% of daily cap</span>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {top.map((p: any) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", color: T.textSub, width: "90px", flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span>
            {bar(p.pctUsed)}
            <span style={{
              fontSize: "11px", fontWeight: 600, width: "52px", textAlign: "right", flexShrink: 0,
              color: p.pctUsed == null ? T.muted : p.pctUsed >= 90 ? T.red : p.pctUsed >= 60 ? T.amber : T.text,
            }}>
              {p.todayCalls} {p.limit != null ? `/ ${p.limit}` : "calls"}
            </span>
          </div>
        ))}
      </div>

      {!bottleneck && top.length > 0 && (
        <div style={{ marginTop: "10px", fontSize: "11px", color: T.muted }}>All capped providers within limit.</div>
      )}
    </div>
  );
}
