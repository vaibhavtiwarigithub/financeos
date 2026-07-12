"use client";
import { useState, useEffect } from "react";
import ModelFreshnessCard from "@/components/dashboard/ModelFreshnessCard";

// Self-contained LLM configuration: per-agent/flow model picker + provider API
// keys (vault-backed) + freshness check. Rendered in Settings → AI Models (the
// discoverable home) and reused inside Agents → LLM Config. Owns all its state
// and talks straight to /api/agents/agent-config and /api/agents/provider-keys,
// so it can be dropped anywhere with zero wiring.

const T = {
  card: "#1A1D27", border: "#252836", surface: "#13151C", dim: "#0F1117",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#6366F1", green: "#34D399",
};

type AgentCfg = { agent_name: string; model: string; max_tokens?: number; temperature?: number; enabled: boolean; notes?: string };
type ProviderKey = { provider: string; label: string; source: string; last4: string | null };

export default function LLMConfigPanel() {
  const [agentConfigs, setAgentConfigs] = useState<AgentCfg[]>([]);
  const [configUpdating, setConfigUpdating] = useState<string | null>(null);
  const [configToast, setConfigToast] = useState("");
  const [freshKey, setFreshKey] = useState(0);

  const [providerKeys, setProviderKeys] = useState<ProviderKey[]>([]);
  const [pkInputs, setPkInputs] = useState<Record<string, string>>({});
  const [pkSaving, setPkSaving] = useState<string | null>(null);
  const [pkToast, setPkToast] = useState("");

  useEffect(() => {
    fetch("/api/agents/agent-config").then(r => r.json()).then(d => { if (d.configs) setAgentConfigs(d.configs); }).catch(() => {});
    fetch("/api/agents/provider-keys").then(r => r.json()).then(d => { if (d.providers) setProviderKeys(d.providers); }).catch(() => {});
  }, []);

  async function updateAgentConfig(agent_name: string, field: string, value: unknown) {
    setConfigUpdating(agent_name);
    try {
      await fetch("/api/agents/agent-config", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent_name, [field]: value }) });
      setAgentConfigs(prev => prev.map(c => c.agent_name === agent_name ? { ...c, [field]: value } as AgentCfg : c));
      setFreshKey(k => k + 1);
      setConfigToast("Saved!");
      setTimeout(() => setConfigToast(""), 2000);
    } catch {}
    setConfigUpdating(null);
  }

  async function saveProviderKey(provider: string) {
    const key = (pkInputs[provider] ?? "").trim();
    if (key.length < 8) { setPkToast("Key looks too short"); setTimeout(() => setPkToast(""), 2500); return; }
    setPkSaving(provider);
    try {
      const r = await fetch("/api/agents/provider-keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, key }) });
      const d = await r.json();
      if (r.ok && d.providers) { setProviderKeys(d.providers); setPkInputs(prev => ({ ...prev, [provider]: "" })); setPkToast("Key saved"); }
      else setPkToast(d.error ?? "Save failed");
    } catch { setPkToast("Save failed"); }
    setPkSaving(null);
    setTimeout(() => setPkToast(""), 2500);
  }

  async function clearProviderKey(provider: string) {
    if (!confirm(`Remove the ${provider} key from Settings and revert to the deployment's env var?`)) return;
    setPkSaving(provider);
    try {
      const r = await fetch(`/api/agents/provider-keys?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
      const d = await r.json();
      if (r.ok && d.providers) { setProviderKeys(d.providers); setPkToast("Reverted to env"); }
    } catch { setPkToast("Clear failed"); }
    setPkSaving(null);
    setTimeout(() => setPkToast(""), 2500);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <ModelFreshnessCard refreshKey={freshKey} />

      {/* Per-agent model picker */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,20px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "16px" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "14px", color: T.text }}>Agent / Flow → LLM</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Pick the model for each flow — no code deploy. Reasoner/best for research, trade, judgment; fast/cheap for chat + screening.</div>
          </div>
          {configToast && <span style={{ fontSize: "12px", color: T.green }}>{configToast}</span>}
        </div>
        {agentConfigs.length === 0 ? (
          <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "30px 0" }}>Loading agent config…</div>
        ) : (
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px", minWidth: "560px" }}>
              {agentConfigs.map(cfg => (
                <div key={cfg.agent_name} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px", display: "grid", gridTemplateColumns: "150px 1fr 80px 80px 100px", gap: "12px", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: "13px", color: T.text }}>{cfg.agent_name}</div>
                    {cfg.notes && <div style={{ fontSize: "11px", color: T.muted, marginTop: "2px" }}>{cfg.notes}</div>}
                  </div>
                  <select
                    value={cfg.model}
                    onChange={e => updateAgentConfig(cfg.agent_name, "model", e.target.value)}
                    disabled={configUpdating === cfg.agent_name}
                    style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "12px", padding: "5px 8px", outline: "none", cursor: "pointer" }}
                  >
                    <optgroup label="DeepSeek">
                      <option value="deepseek-chat">deepseek-chat (V3 — cheap)</option>
                      <option value="deepseek-reasoner">deepseek-reasoner (R1 — thinking, slower)</option>
                    </optgroup>
                    <optgroup label="Groq (Free)">
                      <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile</option>
                      <option value="llama-3.1-8b-instant">llama-3.1-8b-instant (fastest)</option>
                      <option value="deepseek-r1-distill-llama-70b">deepseek-r1-distill-llama-70b</option>
                    </optgroup>
                    <optgroup label="Claude (Paid)">
                      <option value="claude-haiku-4-5">claude-haiku-4-5 (fast/cheap)</option>
                      <option value="claude-sonnet-4-6">claude-sonnet-4-6 (best)</option>
                    </optgroup>
                    <optgroup label="Google Gemini (Paid)">
                      <option value="gemini-2.5-flash">gemini-2.5-flash (fast/cheap)</option>
                      <option value="gemini-2.5-pro">gemini-2.5-pro (best)</option>
                    </optgroup>
                    <optgroup label="xAI Grok (Paid)">
                      <option value="grok-4-fast">grok-4-fast (fast/cheap)</option>
                      <option value="grok-4">grok-4 (best)</option>
                    </optgroup>
                    <optgroup label="OpenAI ChatGPT (Paid)">
                      <option value="gpt-4o-mini">gpt-4o-mini (fast/cheap)</option>
                      <option value="gpt-4o">gpt-4o</option>
                      <option value="gpt-4.1">gpt-4.1 (best)</option>
                    </optgroup>
                    <optgroup label="Zhipu GLM (Paid)">
                      <option value="glm-4.5-air">glm-4.5-air (fast/cheap)</option>
                      <option value="glm-4.6">glm-4.6 (best)</option>
                    </optgroup>
                  </select>
                  <div style={{ fontSize: "11px", color: T.muted, textAlign: "right" }}>
                    <div>tokens</div>
                    <input type="number" min={256} max={8192} step={256} value={cfg.max_tokens ?? 2048}
                      onChange={e => updateAgentConfig(cfg.agent_name, "max_tokens", Number(e.target.value))}
                      style={{ width: "72px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "5px", color: T.text, fontSize: "12px", padding: "3px 6px", outline: "none", marginTop: "3px", textAlign: "right" }} />
                  </div>
                  <div style={{ fontSize: "11px", color: T.muted, textAlign: "right" }}>
                    <div>temp</div>
                    <input type="number" min={0} max={2} step={0.1} value={cfg.temperature ?? 0.3}
                      onChange={e => updateAgentConfig(cfg.agent_name, "temperature", Number(e.target.value))}
                      style={{ width: "56px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "5px", color: T.text, fontSize: "12px", padding: "3px 6px", outline: "none", marginTop: "3px", textAlign: "right" }} />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                    <span style={{ fontSize: "11px", color: T.muted }}>enabled</span>
                    <div
                      onClick={() => updateAgentConfig(cfg.agent_name, "enabled", !cfg.enabled)}
                      style={{ width: "36px", height: "20px", borderRadius: "10px", background: cfg.enabled ? T.accent : T.border, cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
                      <div style={{ position: "absolute", top: "3px", left: cfg.enabled ? "18px" : "3px", width: "14px", height: "14px", borderRadius: "50%", background: "#fff", transition: "left 0.2s" }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Provider API keys — vault-backed, write-only */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,20px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px", marginBottom: "6px" }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: "14px", color: T.text }}>Provider API Keys</div>
            <div style={{ fontSize: "12px", color: T.muted, marginTop: "3px" }}>Set a key to override the deployment env var. Stored encrypted in the vault, never shown again — only the last 4 digits.</div>
          </div>
          {pkToast && <span style={{ fontSize: "12px", color: T.green }}>{pkToast}</span>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginTop: "12px" }}>
          {providerKeys.map(pk => {
            const srcColor = pk.source === "vault" ? T.green : pk.source === "env" ? T.muted : "#c0392b";
            const srcLabel = pk.source === "vault" ? `Settings ••${pk.last4}` : pk.source === "env" ? `env ••${pk.last4}` : "not set";
            return (
              <div key={pk.provider} style={{ background: T.surface, borderRadius: "10px", padding: "14px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px" }}>
                <div style={{ minWidth: "150px", flex: "1 1 150px" }}>
                  <div style={{ fontWeight: 600, fontSize: "13px", color: T.text }}>{pk.label}</div>
                  <div style={{ fontSize: "11px", color: srcColor, marginTop: "2px" }}>{srcLabel}</div>
                </div>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Paste new key…"
                  value={pkInputs[pk.provider] ?? ""}
                  onChange={e => setPkInputs(prev => ({ ...prev, [pk.provider]: e.target.value }))}
                  style={{ flex: "2 1 200px", minWidth: "160px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "6px", color: T.text, fontSize: "12px", padding: "7px 10px", outline: "none" }}
                />
                <button
                  onClick={() => saveProviderKey(pk.provider)}
                  disabled={pkSaving === pk.provider || !(pkInputs[pk.provider] ?? "").trim()}
                  style={{ background: T.accent, color: "#fff", border: "none", borderRadius: "6px", fontSize: "12px", fontWeight: 600, padding: "7px 14px", cursor: "pointer", opacity: pkSaving === pk.provider || !(pkInputs[pk.provider] ?? "").trim() ? 0.5 : 1 }}
                >{pkSaving === pk.provider ? "Saving…" : "Save"}</button>
                {pk.source === "vault" && (
                  <button
                    onClick={() => clearProviderKey(pk.provider)}
                    disabled={pkSaving === pk.provider}
                    style={{ background: "transparent", color: T.muted, border: `1px solid ${T.border}`, borderRadius: "6px", fontSize: "12px", padding: "7px 12px", cursor: "pointer" }}
                  >Clear</button>
                )}
              </div>
            );
          })}
          {providerKeys.length === 0 && (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center", padding: "16px 0" }}>Loading providers…</div>
          )}
        </div>
      </div>
    </div>
  );
}
