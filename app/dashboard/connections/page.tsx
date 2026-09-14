"use client";

// A user's own broker connections.
//
// Shows connection STATE only — never a token. Staleness is deliberately loud:
// the owner accepted the daily Zerodha login (2026-09-14) on the condition that
// an expired session is obvious rather than silently producing yesterday's
// numbers, so a stale connection gets a full-width amber banner and an explicit
// "Reconnect", not a quiet grey dot.

import React, { useCallback, useEffect, useState } from "react";

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", textSub: "#9B9EA8", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", red: "#EF4444", amber: "#EAB308", amberBg: "#2D1B00",
};

type Connection = {
  broker: "robinhood" | "kite";
  connected: boolean;
  stale: boolean;
  staleReason: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

type Payload = {
  connections: Connection[];
  encryption_ready: boolean;
  supported: Record<string, boolean>;
};

const LABEL: Record<string, string> = { kite: "Zerodha Kite (India)", robinhood: "Robinhood (US)" };

export default function ConnectionsPage() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/broker-connections", { cache: "no-store" });
      if (!res.ok) { setError(`Could not load connections (${res.status})`); return; }
      setData(await res.json());
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const kite = new URLSearchParams(window.location.search).get("kite");
    if (!kite) return;
    setFlash({
      connected: "Zerodha connected. Your risk analytics will refresh on the next run.",
      exchange_failed: "Zerodha rejected the login. Please try again.",
      login_expired: "That login attempt expired. Please start again.",
      login_failed: "Zerodha login was cancelled or failed.",
      missing_key: "This app is not configured for Zerodha yet — ask the owner.",
      store_failed: "Connected to Zerodha, but the session could not be saved securely. Ask the owner to check configuration.",
    }[kite] ?? null);
  }, []);

  async function disconnect(broker: string) {
    if (!confirm(`Disconnect ${LABEL[broker] ?? broker}?\n\nYour risk analytics will stop updating until you reconnect. Nothing is traded either way.`)) return;
    setBusy(broker);
    try {
      const res = await fetch("/api/broker-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect", broker }),
      });
      if (!res.ok) setError(`Disconnect failed (${res.status})`);
      else { setFlash(null); await load(); }
    } finally { setBusy(null); }
  }

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: "12px", padding: "18px 20px", marginBottom: "14px",
  };

  return (
    <div style={{ padding: "24px", color: T.text, maxWidth: "820px" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>Broker Connections</h1>
      <p style={{ fontSize: "12px", color: T.muted, marginBottom: "18px", lineHeight: 1.6 }}>
        Connect your own brokerage to see risk analytics on <strong>your</strong> holdings — exposure,
        concentration and correlation. Access is <strong>read-only</strong>: nothing can be bought,
        sold or cancelled in your account. Only you can see this data.
      </p>

      {flash && <div style={{ ...card, borderColor: T.accent, fontSize: "12px" }}>{flash}</div>}
      {error && <div style={{ ...card, borderColor: T.red, color: T.red, fontSize: "12px" }}>{error}</div>}

      {data && !data.encryption_ready && (
        <div style={{ ...card, borderColor: T.amber, background: T.amberBg, fontSize: "12px" }}>
          <strong style={{ color: T.amber }}>Connections are unavailable.</strong> This app is not yet
          configured to store broker credentials securely. Nothing is broken on your side — ask the owner.
        </div>
      )}

      {data?.connections.map((c) => {
        const supported = data.supported?.[c.broker] !== false;
        return (
          <div key={c.broker} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: "14px", fontWeight: 600 }}>{LABEL[c.broker]}</div>
                <div style={{ fontSize: "11px", color: c.connected ? (c.stale ? T.amber : T.green) : T.muted, marginTop: "3px", fontWeight: 600 }}>
                  {!supported ? "Coming soon" : c.connected ? (c.stale ? "Action needed" : "Connected") : "Not connected"}
                  {c.connected && c.connectedAt && !c.stale && (
                    <span style={{ color: T.muted, fontWeight: 400 }}>
                      {" "}· since {new Date(c.connectedAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                {supported && data.encryption_ready && (
                  <a
                    href="/api/broker-connections/kite/login"
                    style={{
                      background: c.connected && !c.stale ? "transparent" : T.accent,
                      border: c.connected && !c.stale ? `1px solid ${T.border}` : "none",
                      color: c.connected && !c.stale ? T.textSub : "#fff",
                      borderRadius: "6px", padding: "7px 16px", fontSize: "12px",
                      fontWeight: 600, textDecoration: "none",
                    }}
                  >
                    {c.connected ? (c.stale ? "Reconnect" : "Refresh session") : "Connect"}
                  </a>
                )}
                {c.connected && (
                  <button
                    onClick={() => disconnect(c.broker)}
                    disabled={busy === c.broker}
                    style={{
                      background: "transparent", border: `1px solid ${T.red}`, color: T.red,
                      borderRadius: "6px", padding: "7px 14px", fontSize: "12px", fontWeight: 600, cursor: "pointer",
                    }}
                  >
                    {busy === c.broker ? "…" : "Disconnect"}
                  </button>
                )}
              </div>
            </div>

            {/* The owner's condition for accepting the daily Zerodha login:
                staleness must be impossible to miss. */}
            {c.connected && c.stale && c.staleReason && (
              <div style={{
                marginTop: "12px", background: T.amberBg, border: `1px solid ${T.amber}`,
                borderRadius: "8px", padding: "10px 12px", fontSize: "12px", color: T.text, lineHeight: 1.5,
              }}>
                <strong style={{ color: T.amber }}>Your figures are out of date. </strong>
                {c.staleReason}
              </div>
            )}

            {c.lastError && (
              <div style={{ marginTop: "10px", fontSize: "11px", color: T.red }}>{c.lastError}</div>
            )}
          </div>
        );
      })}

      <p style={{ fontSize: "11px", color: T.muted, marginTop: "18px", lineHeight: 1.6 }}>
        Your broker session is encrypted before it is stored and is never shown back to you or to
        anyone else — including the owner of this app, who can see that you are connected but not
        what you hold. Disconnecting erases the stored session immediately.
      </p>
    </div>
  );
}
