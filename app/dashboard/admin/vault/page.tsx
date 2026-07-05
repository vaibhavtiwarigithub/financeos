"use client";
import { useState, useCallback } from "react";

// REQUIRED ENV VAR: Add VAULT_PIN=fos-vault-2026 to your .env.local
// The vault API route checks this header on every request.

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

const PROVIDERS = ["anthropic", "deepseek", "gemini", "openai", "groq", "massive", "alphavantage", "financialdatasets", "robinhood", "resend", "supabase", "other"] as const;
const ALL_TASKS = ["research", "trade", "evaluate", "thesis", "chat", "summarize", "data", "embed", "market_data", "sentiment", "options"];
// Model ID / cost-per-token / tasks-suitable only mean something for an LLM
// provider — showing them for a data-API key (Massive, AlphaVantage,
// FinancialDatasets, Robinhood, Resend) is what made editing
// FINANCIAL_DATASETS_API_KEY confusing (fields pre-filled with leftover
// LLM values like "anthropic" / "Claude Sonnet 4.6" that don't apply).
const LLM_PROVIDERS = new Set(["anthropic", "deepseek", "gemini", "openai", "groq"]);

interface VaultKey {
  id: string;
  key_name: string;
  key_value: string; // masked from server
  display_name: string;
  provider: string;
  model_id: string | null;
  tasks_suitable: string[];
  cost_per_1m_input: number;
  cost_per_1m_output: number;
  enabled: boolean;
  notes: string | null;
  added_at: string;
  updated_at: string;
  env_set: boolean;
  env_masked: string | null;
}

const emptyForm = {
  key_name: "", key_value: "", display_name: "", provider: "anthropic" as string,
  model_id: "", tasks_suitable: [] as string[], cost_per_1m_input: 0,
  cost_per_1m_output: 0, enabled: true, notes: "",
};

export default function VaultPage() {
  const [pin, setPin] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [pinError, setPinError] = useState("");
  const [keys, setKeys] = useState<VaultKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [saveMsg, setSaveMsg] = useState("");
  const [showChangePIN, setShowChangePIN] = useState(false);
  const [newPIN, setNewPIN] = useState("");
  const [changePINMsg, setChangePINMsg] = useState("");
  const [changingPIN, setChangingPIN] = useState(false);

  const unlock = useCallback(async () => {
    if (!pin.trim()) return;
    setLoading(true);
    setPinError("");
    try {
      const res = await fetch("/api/admin/vault", {
        headers: { "x-vault-pin": pin },
      });
      if (res.status === 403) {
        setPinError("Wrong PIN. Only the account owner can access.");
        setLoading(false);
        return;
      }
      if (res.status === 401) {
        setPinError("Not authorized. Sign in as vterminater@gmail.com.");
        setLoading(false);
        return;
      }
      const data = await res.json();
      if (data.error) {
        setPinError(data.error);
        setLoading(false);
        return;
      }
      setKeys(data.keys ?? []);
      setUnlocked(true);
    } catch {
      setPinError("Network error — vault unavailable.");
    }
    setLoading(false);
  }, [pin]);

  async function toggle(keyName: string, enabled: boolean) {
    await fetch("/api/admin/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vault-pin": pin },
      body: JSON.stringify({ action: "toggle", key_name: keyName, enabled }),
    });
    setKeys(prev => prev.map(k => k.key_name === keyName ? { ...k, enabled } : k));
  }

  async function saveKey() {
    const isEdit = keys.some(k => k.key_name === form.key_name);
    if (!form.key_name || (!form.key_value && !isEdit) || !form.display_name || !form.provider) {
      setSaveMsg(isEdit ? "Display name and provider are required." : "Key name, value, display name, and provider are required.");
      return;
    }
    setSaving(true);
    setSaveMsg("");
    const res = await fetch("/api/admin/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vault-pin": pin },
      body: JSON.stringify({ action: "upsert", ...form }),
    });
    const data = await res.json();
    if (data.error) {
      setSaveMsg("Error: " + data.error);
    } else {
      setSaveMsg("Saved.");
      setForm(emptyForm);
      setShowAddForm(false);
      // Refresh list
      const listRes = await fetch("/api/admin/vault", { headers: { "x-vault-pin": pin } });
      const listData = await listRes.json();
      setKeys(listData.keys ?? []);
    }
    setSaving(false);
  }

  async function changePIN() {
    if (!newPIN.trim()) return;
    setChangingPIN(true);
    setChangePINMsg("");
    const res = await fetch("/api/admin/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-vault-pin": pin },
      body: JSON.stringify({ action: "change_pin", new_pin: newPIN }),
    });
    const data = await res.json();
    if (data.error) {
      setChangePINMsg("Error: " + data.error);
    } else {
      setPin(newPIN);
      setNewPIN("");
      setShowChangePIN(false);
      setChangePINMsg("PIN changed. Using new PIN for this session.");
    }
    setChangingPIN(false);
  }

  function editKey(k: VaultKey) {
    setForm({
      key_name: k.key_name,
      key_value: "", // masked — user must re-enter to change
      display_name: k.display_name,
      provider: k.provider,
      model_id: k.model_id ?? "",
      tasks_suitable: k.tasks_suitable ?? [],
      cost_per_1m_input: k.cost_per_1m_input,
      cost_per_1m_output: k.cost_per_1m_output,
      enabled: k.enabled,
      notes: k.notes ?? "",
    });
    setSaveMsg("");
    setShowAddForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggleTask(task: string) {
    setForm(f => ({
      ...f,
      tasks_suitable: f.tasks_suitable.includes(task)
        ? f.tasks_suitable.filter(t => t !== task)
        : [...f.tasks_suitable, task],
    }));
  }

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: "12px", padding: "20px",
  };
  const inp: React.CSSProperties = {
    background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px",
    color: T.text, padding: "8px 12px", fontSize: "13px", width: "100%", boxSizing: "border-box",
    outline: "none",
  };
  const btn = (bg: string, fg = T.text): React.CSSProperties => ({
    background: bg, color: fg, border: "none", borderRadius: "8px",
    padding: "9px 18px", fontSize: "13px", fontWeight: 600, cursor: "pointer",
  });
  const label: React.CSSProperties = {
    fontSize: "11px", color: T.muted, marginBottom: "4px", display: "block", fontWeight: 500,
    textTransform: "uppercase", letterSpacing: "0.05em",
  };

  if (!unlocked) {
    return (
      <div style={{ padding: "28px", maxWidth: "460px" }}>
        <div style={{ fontSize: "20px", fontWeight: 600, marginBottom: "6px" }}>API Key Vault</div>
        <div style={{ fontSize: "13px", color: T.muted, marginBottom: "24px" }}>
          Enter your vault PIN to unlock.
        </div>

        {/* Security note */}
        <div style={{ ...card, borderColor: T.accent + "44", background: T.accent + "0D", marginBottom: "24px" }}>
          <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>
            <strong style={{ color: T.accent }}>Security notice:</strong> This vault is protected by
            your Supabase session (<span style={{ color: T.text }}>vterminater@gmail.com</span>) +
            vault PIN. Never share your PIN. Keys are masked in transit.
          </div>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center", marginBottom: "12px" }}>
          <input
            type="password"
            placeholder="Vault PIN"
            value={pin}
            onChange={e => setPin(e.target.value)}
            onKeyDown={e => e.key === "Enter" && unlock()}
            style={{ ...inp, flex: 1 }}
            autoFocus
          />
          <button onClick={unlock} disabled={loading} style={btn(T.accent)}>
            {loading ? "Checking…" : "Unlock Vault"}
          </button>
        </div>

        {pinError && (
          <div style={{ fontSize: "13px", color: T.red, padding: "10px", background: T.red + "15", borderRadius: "8px" }}>
            {pinError}
          </div>
        )}
      </div>
    );
  }

  const providerColor: Record<string, string> = {
    anthropic: "#C084FC", deepseek: "#60A5FA", gemini: "#34D399",
    openai: "#FBBF24", groq: "#F97316", massive: "#A3E635",
    alphavantage: "#38BDF8", robinhood: "#00C805", supabase: "#3ECF8E",
    other: T.muted,
  };

  return (
    <div style={{ padding: "28px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "6px" }}>
        <div style={{ fontSize: "20px", fontWeight: 600 }}>API Key Vault</div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={() => { setShowChangePIN(v => !v); setChangePINMsg(""); }} style={btn("#252836")}>
            {showChangePIN ? "Cancel" : "Change PIN"}
          </button>
          <button onClick={() => { setShowAddForm(v => !v); setForm(emptyForm); setSaveMsg(""); }} style={btn(T.accent)}>
            {showAddForm ? "Cancel" : "+ Add Key"}
          </button>
        </div>
      </div>
      <div style={{ fontSize: "13px", color: T.muted, marginBottom: showChangePIN ? "12px" : "24px" }}>
        {keys.length} key{keys.length !== 1 ? "s" : ""} registered
      </div>

      {showChangePIN && (
        <div style={{ ...card, marginBottom: "20px", borderColor: T.yellow + "44" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px", color: T.yellow }}>Change Vault PIN</div>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <input
              type="password"
              placeholder="New PIN"
              value={newPIN}
              onChange={e => setNewPIN(e.target.value)}
              onKeyDown={e => e.key === "Enter" && changePIN()}
              style={{ ...inp, flex: 1 }}
            />
            <button onClick={changePIN} disabled={changingPIN || !newPIN} style={btn(T.yellow, "#000")}>
              {changingPIN ? "Changing…" : "Set PIN"}
            </button>
          </div>
          {changePINMsg && (
            <div style={{ marginTop: "8px", fontSize: "12px", color: changePINMsg.startsWith("Error") ? T.red : T.green }}>
              {changePINMsg}
            </div>
          )}
          <div style={{ marginTop: "8px", fontSize: "11px", color: T.muted }}>
            New PIN applies immediately. Update VAULT_PIN in .env.local to persist across server restarts.
          </div>
        </div>
      )}

      {/* Security note */}
      <div style={{ ...card, borderColor: T.accent + "44", background: T.accent + "0D", marginBottom: "20px" }}>
        <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.6" }}>
          <strong style={{ color: T.accent }}>Session active:</strong> You are authenticated as{" "}
          <span style={{ color: T.text }}>vterminater@gmail.com</span> + vault PIN verified.
          Keys are masked in this view. Vault rows are service-role–only (RLS enforced).
        </div>
      </div>

      {/* Add / Edit Key Form */}
      {showAddForm && (
        <div style={{ ...card, marginBottom: "20px", borderColor: form.key_name ? T.yellow + "44" : T.border }}>
          <div style={{ fontSize: "14px", fontWeight: 600, marginBottom: "4px" }}>
            {form.key_name ? `Editing: ${form.key_name}` : "Add New Key"}
          </div>
          {form.key_name && (
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "14px" }}>
              Leave Key Value blank to keep existing value. Fill it to replace.
            </div>
          )}
          {!form.key_name && <div style={{ marginBottom: "16px" }} />}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
            <div>
              <span style={label}>Provider</span>
              <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                style={{ ...inp }}>
                {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <span style={label}>Display Name</span>
              <input style={inp} value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                placeholder="Claude Sonnet 4.6" />
            </div>
            <div>
              <span style={label}>Key Name (env var)</span>
              <input style={inp} value={form.key_name}
                onChange={e => setForm(f => ({ ...f, key_name: e.target.value.toUpperCase() }))}
                placeholder="ANTHROPIC_API_KEY" />
            </div>
            <div>
              <span style={label}>Key Value</span>
              <input style={inp} type="password" value={form.key_value}
                onChange={e => setForm(f => ({ ...f, key_value: e.target.value }))}
                placeholder="sk-ant-..." />
            </div>
            {LLM_PROVIDERS.has(form.provider) && (
              <div>
                <span style={label}>Primary Model ID</span>
                <input style={inp} value={form.model_id}
                  onChange={e => setForm(f => ({ ...f, model_id: e.target.value }))}
                  placeholder="claude-sonnet-4-6" />
              </div>
            )}
            <div>
              <span style={label}>Notes</span>
              <input style={inp} value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. $10 budget loaded 2026-06-29" />
            </div>
            {LLM_PROVIDERS.has(form.provider) && (
              <>
                <div>
                  <span style={label}>Cost per 1M input tokens ($)</span>
                  <input style={inp} type="number" step="0.01" value={form.cost_per_1m_input}
                    onChange={e => setForm(f => ({ ...f, cost_per_1m_input: parseFloat(e.target.value) || 0 }))} />
                </div>
                <div>
                  <span style={label}>Cost per 1M output tokens ($)</span>
                  <input style={inp} type="number" step="0.01" value={form.cost_per_1m_output}
                    onChange={e => setForm(f => ({ ...f, cost_per_1m_output: parseFloat(e.target.value) || 0 }))} />
                </div>
              </>
            )}
          </div>

          {LLM_PROVIDERS.has(form.provider) && (
          <div style={{ marginTop: "14px" }}>
            <span style={label}>Tasks Suitable</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
              {ALL_TASKS.map(task => {
                const on = form.tasks_suitable.includes(task);
                return (
                  <button key={task} onClick={() => toggleTask(task)}
                    style={{
                      padding: "4px 12px", borderRadius: "20px", fontSize: "12px", cursor: "pointer",
                      border: `1px solid ${on ? T.accent : T.border}`,
                      background: on ? T.accent + "22" : "transparent",
                      color: on ? T.accent : T.muted,
                      fontWeight: on ? 600 : 400,
                    }}>
                    {task}
                  </button>
                );
              })}
            </div>
          </div>
          )}

          <div style={{ marginTop: "16px", display: "flex", gap: "10px", alignItems: "center" }}>
            <button onClick={saveKey} disabled={saving} style={btn(T.accent)}>
              {saving ? "Saving…" : "Save Key"}
            </button>
            {saveMsg && (
              <span style={{ fontSize: "13px", color: saveMsg.startsWith("Error") ? T.red : T.green }}>
                {saveMsg}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Keys Table */}
      <div style={card}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${T.border}` }}>
                {["Provider", "Display Name", "Key Name", "Vault Value", "Env Status", "Status", "$/1M in", "$/1M out", "Tasks", "Notes", ""].map(h => (
                  <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: T.muted, fontSize: "10px", fontWeight: 500, textTransform: "uppercase", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {keys.map(k => (
                <tr key={k.id} style={{ borderBottom: `1px solid ${T.border}44` }}>
                  <td style={{ padding: "12px 10px" }}>
                    <span style={{
                      fontSize: "11px", padding: "2px 8px", borderRadius: "4px",
                      background: (providerColor[k.provider] ?? T.muted) + "22",
                      color: providerColor[k.provider] ?? T.muted,
                      fontWeight: 600,
                    }}>
                      {k.provider}
                    </span>
                  </td>
                  <td style={{ padding: "12px 10px" }}>
                    <div style={{ fontWeight: 500, color: T.text }}>{k.display_name}</div>
                    {k.model_id && <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px" }}>{k.model_id}</div>}
                  </td>
                  <td style={{ padding: "12px 10px", fontFamily: "'JetBrains Mono', monospace", color: T.textSub, fontSize: "11px" }}>
                    {k.key_name}
                  </td>
                  <td style={{ padding: "12px 10px", fontFamily: "'JetBrains Mono', monospace", color: T.muted, fontSize: "11px" }}>
                    {k.key_value}
                  </td>
                  <td style={{ padding: "12px 10px" }}>
                    {k.env_set ? (
                      <div>
                        <span style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "4px", background: T.green + "22", color: T.green }}>set</span>
                        {k.env_masked && <div style={{ fontSize: "10px", color: T.muted, marginTop: "3px", fontFamily: "'JetBrains Mono', monospace" }}>{k.env_masked}</div>}
                      </div>
                    ) : (
                      <span style={{ fontSize: "11px", padding: "2px 6px", borderRadius: "4px", background: T.yellow + "22", color: T.yellow }}>not in env</span>
                    )}
                  </td>
                  <td style={{ padding: "12px 10px" }}>
                    <button
                      onClick={() => toggle(k.key_name, !k.enabled)}
                      style={{
                        fontSize: "11px", padding: "3px 10px", borderRadius: "4px", cursor: "pointer",
                        border: "none", fontWeight: 600,
                        background: k.enabled ? T.green + "22" : T.red + "22",
                        color: k.enabled ? T.green : T.red,
                      }}>
                      {k.enabled ? "enabled" : "disabled"}
                    </button>
                  </td>
                  <td style={{ padding: "12px 10px", fontFamily: "'JetBrains Mono', monospace", color: T.textSub }}>
                    ${k.cost_per_1m_input.toFixed(2)}
                  </td>
                  <td style={{ padding: "12px 10px", fontFamily: "'JetBrains Mono', monospace", color: T.textSub }}>
                    ${k.cost_per_1m_output.toFixed(2)}
                  </td>
                  <td style={{ padding: "12px 10px" }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                      {(k.tasks_suitable ?? []).map(t => (
                        <span key={t} style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "3px", background: T.accent + "22", color: T.accent }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ padding: "12px 10px", color: T.muted, fontSize: "11px", maxWidth: "180px" }}>
                    {k.notes ?? "—"}
                  </td>
                  <td style={{ padding: "12px 10px" }}>
                    <button
                      onClick={() => editKey(k)}
                      style={{
                        fontSize: "11px", padding: "3px 10px", borderRadius: "4px", cursor: "pointer",
                        border: `1px solid ${T.accent}44`, background: T.accent + "15",
                        color: T.accent, fontWeight: 600, whiteSpace: "nowrap",
                      }}>
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bottom notes */}
      <div style={{ marginTop: "20px", display: "flex", gap: "12px", flexDirection: "column" }}>
        <div style={{ ...card, borderColor: T.yellow + "44", background: T.yellow + "0A" }}>
          <div style={{ fontSize: "12px", color: T.textSub, lineHeight: "1.7" }}>
            <strong style={{ color: T.yellow }}>Env vs Vault priority:</strong> Keys stored in vault
            are available to the LLM router but env vars in{" "}
            <code style={{ fontSize: "11px", background: T.surface, padding: "1px 5px", borderRadius: "3px" }}>.env.local</code>{" "}
            take priority. To use a new key immediately, restart the dev server after adding.
          </div>
        </div>
      </div>
    </div>
  );
}
