"use client";

import { useCallback, useEffect, useState } from "react";

const C = { card: "#111827", border: "#263244", surface: "#0b1220", text: "#e5e7eb", sub: "#9ca3af", muted: "#6b7280", green: "#34d399", amber: "#fbbf24", accent: "#60a5fa", red: "#f87171" };

export default function DownsideHedgePanel() {
  const [config, setConfig] = useState<any>(null);
  const [state, setState] = useState<any>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/downside-hedge", { cache: "no-store" });
    const data = await res.json();
    if (res.ok) { setConfig(data.config); setState(data.state); }
    else setMessage(data.error ?? "Downside hedge settings unavailable");
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(next: any, confirmation = "") {
    setSaving(true); setMessage("");
    const res = await fetch("/api/settings/downside-hedge", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...next, confirmation }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setMessage(data.error ?? "Save failed"); return; }
    setConfig(data.config); setMessage("Saved");
  }

  if (!config) return null;
  const toggle: React.CSSProperties = { width: 42, height: 24, borderRadius: 12, border: `1px solid ${C.border}`, cursor: "pointer", color: C.text };
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "clamp(16px,4vw,24px)", marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Downside Hedge</div>
          <div style={{ color: C.sub, fontSize: 12, marginTop: 5 }}>US paper only · SH / PSQ · state: <b style={{ color: C.text }}>{state?.state ?? "off"}</b></div>
        </div>
        <span style={{ color: config.paper_execute_enabled ? C.amber : config.enabled ? C.accent : C.muted, fontSize: 12, fontWeight: 700 }}>
          {config.paper_execute_enabled ? "PAPER ACTIVE" : config.enabled ? "SHADOW" : "OFF"}
        </span>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: C.text, fontSize: 13 }}>
          Evaluate hedge conditions
          <button disabled={saving} aria-label="Toggle hedge evaluation" onClick={() => void save({ ...config, enabled: !config.enabled, paper_execute_enabled: false })}
            style={{ ...toggle, background: config.enabled ? C.accent : C.surface }}>{config.enabled ? "On" : "Off"}</button>
        </label>
        <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: C.text, fontSize: 13 }}>
          Execute in paper portfolio
          <button disabled={saving || !config.enabled} aria-label="Toggle paper hedge execution" onClick={() => {
            if (config.paper_execute_enabled) void save({ ...config, paper_execute_enabled: false });
            else {
              const confirmation = window.prompt("Type ENABLE PAPER HEDGE to allow simulated hedge orders.") ?? "";
              if (confirmation) void save({ ...config, paper_execute_enabled: true }, confirmation);
            }
          }} style={{ ...toggle, background: config.paper_execute_enabled ? C.amber : C.surface, opacity: config.enabled ? 1 : 0.45 }}>
            {config.paper_execute_enabled ? "On" : "Off"}
          </button>
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12 }}>
          <label style={{ color: C.sub, fontSize: 12 }}>Target NAV %
            <input type="number" min={1} max={8} value={config.target_nav_pct} onChange={(e) => setConfig({ ...config, target_nav_pct: Number(e.target.value) })}
              style={{ width: "100%", marginTop: 6, boxSizing: "border-box", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "8px 10px" }} />
          </label>
          <label style={{ color: C.sub, fontSize: 12 }}>Hard cap NAV %
            <input type="number" min={1} max={10} value={config.max_nav_pct} onChange={(e) => setConfig({ ...config, max_nav_pct: Number(e.target.value) })}
              style={{ width: "100%", marginTop: 6, boxSizing: "border-box", background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, padding: "8px 10px" }} />
          </label>
        </div>
        <button disabled={saving} onClick={() => void save(config, config.paper_execute_enabled ? "ENABLE PAPER HEDGE" : "")}
          style={{ justifySelf: "start", background: C.accent, border: 0, borderRadius: 6, color: "#fff", padding: "8px 16px", fontWeight: 600, cursor: "pointer" }}>
          {saving ? "Saving..." : "Save limits"}
        </button>
      </div>
      {message && <div style={{ color: message === "Saved" ? C.green : C.red, fontSize: 12, marginTop: 12 }}>{message}</div>}
    </div>
  );
}
