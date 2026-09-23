"use client";
// Settings control for L4 live trading of crypto (BTC/ETH/SOL). Mirrors
// LeveragedLiveSettings.tsx exactly, its own separate panel — crypto has
// its own decoupled flags (CRYPTO_LIVE_ENABLED / crypto_live_auto_enabled),
// its own lease, and no shared protective_orders_enabled dependency (crypto's
// broker-native stop is placed directly via placeRobinhoodCryptoOrder, not
// the equity-shaped lib/protective/placement-worker.ts).
import { useEffect, useState } from "react";

const T = {
  card: "#1A1D27", surface: "#13151C", border: "#252836", text: "#ECEDEF",
  textSub: "#9B9EA8", muted: "#6B7280", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

const CONFIRM_TEXT = "ENABLE CRYPTO LIVE";

export default function CryptoLiveSettings() {
  const [data, setData] = useState<any | null>(null);
  const [showEnable, setShowEnable] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [leaseInput, setLeaseInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = () => fetch("/api/settings/crypto-live").then(r => r.json()).then(d => {
    setData(d);
    setLeaseInput(String(d.crypto_live_lease_usd ?? 0));
  }).catch(() => undefined);

  useEffect(() => { load(); }, []);

  async function patch(body: Record<string, unknown>) {
    setSaving(true); setMsg("");
    try {
      const r = await fetch("/api/settings/crypto-live", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) setMsg(d.error ?? "Failed");
      else { setMsg("Saved."); load(); }
    } catch { setMsg("Request failed"); }
    setSaving(false);
  }

  const active = data?.crypto_live_auto_enabled && data?.deployment_flag_active
    && data?.robinhood_crypto_account_eligible && Number(data?.crypto_live_lease_usd ?? 0) > 0;

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "clamp(16px,4vw,24px)", marginTop: "20px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "6px" }}>
        <div style={{ fontSize: "13px", fontWeight: 700, letterSpacing: "0.08em", color: T.muted, textTransform: "uppercase" }}>Crypto — Live Trading (BTC/ETH/SOL)</div>
        {data && (
          <span style={{ fontSize: "11px", padding: "2px 8px", borderRadius: "12px",
            background: active ? "#0D2410" : "#1A1A2E", color: active ? T.green : T.muted,
            border: `1px solid ${active ? T.green : T.border}` }}>
            {active ? "ACTIVE" : "INACTIVE"}
          </span>
        )}
      </div>
      <div style={{ fontSize: "13px", color: T.textSub, marginBottom: "16px" }}>
        Its own book, own lease, own flags — separate from equities and the leveraged sleeve. Broker-native stop via a real stop_price order (confirmed via capability probe, 2026-09-23) — no live order without a confirmed resting stop.
      </div>

      <div style={{ background: T.surface, borderRadius: "8px", padding: "10px 14px", marginBottom: "16px", fontSize: "12px", display: "flex", flexDirection: "column", gap: "8px" }}>
        {([
          ["Deployment flag (CRYPTO_LIVE_ENABLED)", data?.deployment_flag_active, data?.deployment_flag_active ? "true in deployment config" : "false — set in Vercel env"],
          ["DB toggle (this panel)", data?.crypto_live_auto_enabled, data?.crypto_live_auto_enabled ? "enabled" : "disabled"],
          ["Robinhood crypto account eligible", data?.robinhood_crypto_account_eligible, data?.robinhood_crypto_account_eligible ? "eligible" : "not eligible / not connected"],
          ["Live lease > $0", Number(data?.crypto_live_lease_usd ?? 0) > 0, `$${data?.crypto_live_lease_usd ?? 0}`],
        ] as const).map(([label, ok, detail]) => (
          <div key={label} style={{ display: "flex", gap: "8px", alignItems: "baseline" }}>
            <span style={{ color: ok ? T.green : T.red, fontSize: "13px", width: "14px" }}>{ok ? "✓" : "✗"}</span>
            <span style={{ color: T.textSub }}>{label}:</span>
            <span style={{ color: ok ? T.green : T.muted, fontWeight: 600 }}>{detail}</span>
          </div>
        ))}
      </div>

      {data?.open_positions?.length > 0 && (
        <div style={{ marginBottom: "16px", fontSize: "12px" }}>
          <span style={{ color: T.muted }}>Open live positions: </span>
          {data.open_positions.map((p: any) => (
            <span key={p.symbol} style={{ color: T.yellow, fontWeight: 600, marginRight: "10px" }}>{p.symbol} × {p.qty}</span>
          ))}
        </div>
      )}

      <div style={{ marginBottom: "16px" }}>
        <label style={{ fontSize: "11px", color: T.muted, display: "block", marginBottom: "4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Live lease (USD, combined across BTC/ETH/SOL — NOT per coin)
        </label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="number" min="0" step="10" value={leaseInput}
            onChange={e => setLeaseInput(e.target.value)}
            style={{ width: "140px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none" }}
          />
          <button disabled={saving} onClick={() => patch({ action: "set_lease", lease_usd: leaseInput })}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, padding: "8px 16px", fontSize: "13px", cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
            Save lease
          </button>
        </div>
      </div>

      {!data?.crypto_live_auto_enabled ? (
        showEnable ? (
          <div style={{ background: "#1A0A0A", border: `1px solid ${T.red}44`, borderRadius: "10px", padding: "16px", marginBottom: "12px" }}>
            <div style={{ fontSize: "12px", color: T.red, fontWeight: 600, marginBottom: "10px" }}>
              Type &quot;{CONFIRM_TEXT}&quot; to confirm
            </div>
            <input value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={CONFIRM_TEXT}
              style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: T.text, fontSize: "13px", padding: "8px 10px", outline: "none", marginBottom: "10px", boxSizing: "border-box" }} />
            <div style={{ display: "flex", gap: "8px" }}>
              <button disabled={saving || !data?.deployment_flag_active || confirm !== CONFIRM_TEXT}
                onClick={async () => { await patch({ action: "enable", confirmation_text: confirm }); setShowEnable(false); setConfirm(""); }}
                style={{ background: confirm === CONFIRM_TEXT && data?.deployment_flag_active ? T.red : T.surface,
                  border: `1px solid ${T.red}`, borderRadius: "8px", color: confirm === CONFIRM_TEXT && data?.deployment_flag_active ? "#fff" : T.red,
                  padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: confirm !== CONFIRM_TEXT || !data?.deployment_flag_active ? "not-allowed" : "pointer", opacity: saving ? 0.7 : 1 }}>
                {saving ? "Enabling…" : "Enable Crypto Live"}
              </button>
              <button onClick={() => { setShowEnable(false); setConfirm(""); }}
                style={{ background: "none", border: `1px solid ${T.border}`, borderRadius: "8px", color: T.muted, padding: "9px 16px", fontSize: "13px", cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setShowEnable(true)} disabled={!data?.deployment_flag_active}
            title={!data?.deployment_flag_active ? "CRYPTO_LIVE_ENABLED must be true first" : undefined}
            style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: "8px", color: data?.deployment_flag_active ? T.text : T.muted,
              padding: "9px 20px", fontSize: "13px", cursor: data?.deployment_flag_active ? "pointer" : "not-allowed", opacity: data?.deployment_flag_active ? 1 : 0.5 }}>
            Enable Crypto Live…
          </button>
        )
      ) : (
        <button disabled={saving} onClick={() => patch({ action: "disable" })}
          style={{ background: "#2D0A0A", border: `1px solid ${T.red}`, borderRadius: "8px", color: T.red, padding: "9px 20px", fontSize: "13px", fontWeight: 600, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
          {saving ? "Disabling…" : "Disable Crypto Live"}
        </button>
      )}

      {msg && (
        <div style={{ marginTop: "10px", fontSize: "13px", color: msg.includes("ailed") || msg.includes("error") ? T.red : T.green }}>{msg}</div>
      )}
    </div>
  );
}
