"use client";

import { useEffect, useState } from "react";
import { useMarket } from "@/lib/market-context";

const T = { card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF", sub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399", red: "#F87171" };
type Policy = { market: "us" | "india"; enabled: boolean; auto_shadow_enabled: boolean; max_active_shadows: number };

export default function ValidationAutomationPanel() {
  const { market } = useMarket();
  const [policies, setPolicies] = useState<Record<string, Policy>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [degraded, setDegraded] = useState(false);
  useEffect(() => { fetch("/api/settings/validation-automation").then(r => r.json()).then(d => {
    setPolicies(Object.fromEntries((d.policies ?? []).map((p: Policy) => [p.market, p])));
    setDegraded(!!d.degraded);
  }).catch(() => setMessage("Could not load validation automation.")); }, []);
  const policy = policies[market];
  async function save(next: Policy) {
    setSaving(true); setMessage("");
    try {
      const res = await fetch("/api/settings/validation-automation", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setPolicies(prev => ({ ...prev, [market]: data.policy }));
      setMessage(next.enabled ? "Automatic validation enabled." : "Automatic validation disabled. Existing evidence was preserved.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Save failed"); }
    finally { setSaving(false); }
  }
  if (!policy) return <div style={{ color: T.muted, fontSize: 13 }}>Loading validation automation...</div>;
  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, padding: "clamp(16px,4vw,24px)", marginBottom: 20 }}>
    <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Automatic Strategy Validation: {market === "india" ? "India" : "US"}</div>
    <div style={{ fontSize: 12, color: T.sub, marginTop: 4, marginBottom: 14 }}>New challengers are tested with Kairos evidence. A pass may enter one non-executing shadow slot; it never promotes a champion or submits an order.</div>
    {degraded ? <div style={{ color: T.red, fontSize: 12 }}>Migration 170 is required before this can be changed.</div> : <>
      <label style={{ display: "flex", alignItems: "center", gap: 9, color: T.text, fontSize: 12, marginBottom: 10 }}><input type="checkbox" checked={policy.enabled} disabled={saving} onChange={e => save({ ...policy, enabled: e.target.checked })} />Run validation automatically</label>
      <label style={{ display: "flex", alignItems: "center", gap: 9, color: policy.enabled ? T.text : T.muted, fontSize: 12 }}><input type="checkbox" checked={policy.auto_shadow_enabled} disabled={saving || !policy.enabled} onChange={e => save({ ...policy, auto_shadow_enabled: e.target.checked })} />Route passing challengers into one shadow-evidence slot</label>
      <div style={{ color: T.muted, fontSize: 11, marginTop: 10 }}>Disable either control to return to manual handling. No results or history are deleted.</div>
    </>}
    {message && <div style={{ color: message.includes("disabled") || message.includes("enabled") ? T.green : T.red, fontSize: 12, marginTop: 10 }}>{message}</div>}
  </div>;
}
