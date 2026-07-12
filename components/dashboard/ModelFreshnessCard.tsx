"use client";
import { useState, useEffect } from "react";

const T = {
  card: "#1A1D27", border: "#252836", surface: "#13151C",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", amber: "#FBBF24", red: "#F87171",
};

interface Finding { agent: string; assigned: string; kind: "newer_available" | "deprecated"; detail: string }
interface CheckResult { checked_at: string; findings: Finding[]; providers_ok: Record<string, boolean> }

// Fortnightly-ish freshness check (Ops spec Part 3) — informational only.
// Never auto-switches a model; changes happen in the agent-config picker below.
export default function ModelFreshnessCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const [agentConfig, setAgentConfig] = useState<{ agent_name: string; model: string }[]>([]);
  const [latest, setLatest] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(false);

  function load() {
    fetch("/api/models/check").then(r => r.json()).then(d => { setAgentConfig(d.agentConfig ?? []); setLatest(d.latest ?? null); }).catch(() => {});
  }
  // Re-load on mount AND whenever the parent bumps refreshKey (i.e. a model was
  // changed in the LLM Config picker), so the assignment list here stays current.
  useEffect(() => { load(); }, [refreshKey]);

  async function checkNow() {
    setChecking(true);
    try {
      await fetch("/api/models/check", { method: "POST" });
      load();
    } finally { setChecking(false); }
  }

  const noKeys = latest && Object.values(latest.providers_ok).every(v => !v);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "16px 18px", marginBottom: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
        <div style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" as const }}>Model Freshness</div>
        <button onClick={checkNow} disabled={checking} style={{ background: "transparent", border: `1px solid ${T.accent}`, borderRadius: "6px", color: T.accent, padding: "5px 14px", fontSize: "12px", cursor: "pointer" }}>
          {checking ? "Checking..." : "Check now"}
        </button>
      </div>

      <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px" }}>
        {latest ? `Last checked ${new Date(latest.checked_at).toLocaleString()}` : "Never checked yet."}
      </div>

      {noKeys && (
        <div style={{ fontSize: "12px", color: T.muted, marginBottom: "8px" }}>No provider keys configured — can't check any provider yet.</div>
      )}

      <div style={{ display: "grid", gap: "4px", marginBottom: latest?.findings?.length ? "10px" : 0 }}>
        {agentConfig.map(a => (
          <div key={a.agent_name} style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: T.textSub }}>
            <span>{a.agent_name}</span>
            <span style={{ fontFamily: "monospace", color: T.muted }}>{a.model}</span>
          </div>
        ))}
      </div>

      {latest?.findings?.length ? (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: "8px" }}>
          {latest.findings.map((f, i) => (
            <div key={i} style={{ fontSize: "12px", color: f.kind === "deprecated" ? T.red : T.amber, marginBottom: "4px" }}>
              {f.kind === "deprecated" ? "⚠" : "ℹ"} {f.agent}: {f.detail}
            </div>
          ))}
          <div style={{ fontSize: "11px", color: T.muted, marginTop: "6px" }}>Review and change assignments below — never auto-switched.</div>
        </div>
      ) : latest && !noKeys ? (
        <div style={{ fontSize: "12px", color: T.green }}>All assigned models current.</div>
      ) : null}

      <div style={{ fontSize: "10px", color: T.muted, marginTop: "8px", lineHeight: 1.4 }}>
        Checks models from already-integrated providers only. Architecture-level upgrades (new agent frameworks) come from reviews, not this checker.
      </div>
    </div>
  );
}
