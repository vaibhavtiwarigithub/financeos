"use client";

// Owner-only: who has access, exactly what each role can view or edit, and
// revoke/restore. Rendering is cosmetic — `/api/admin/access` is owner-gated and
// middleware refuses this path for anyone else.

import React, { useCallback, useEffect, useState } from "react";

const T = {
  bg: "#0D0F1A", card: "#12141F", border: "#1E2030",
  text: "#E2E8F0", muted: "#64748B", accent: "#6366F1",
  green: "#22C55E", red: "#EF4444", amber: "#EAB308",
};

type Grant = {
  user_id: string; email: string; role: string;
  granted_at: string; granted_by: string;
  revoked_at: string | null; revoked_by: string | null;
  note: string | null; active: boolean;
};
type AccessData = {
  owner: { email: string; access: { pages: string[]; canEdit: boolean; notes: string } };
  viewer_access: { pages: string[]; canEdit: boolean; notes: string };
  viewer_pages: string[];
  grants: Grant[];
};

export default function AccessPage() {
  const [data, setData] = useState<AccessData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/access", { cache: "no-store" });
      if (!res.ok) { setError(`Failed to load (${res.status})`); return; }
      setData(await res.json());
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function act(userId: string, action: "revoke" | "restore") {
    setBusy(userId);
    try {
      const res = await fetch("/api/admin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, action }),
      });
      if (!res.ok) setError(`${action} failed (${res.status})`);
      else await load();
    } finally { setBusy(null); }
  }

  const card: React.CSSProperties = {
    background: T.card, border: `1px solid ${T.border}`,
    borderRadius: "12px", padding: "18px 20px", marginBottom: "16px",
  };

  return (
    <div style={{ padding: "24px", color: T.text, maxWidth: "1000px" }}>
      <h1 style={{ fontSize: "20px", fontWeight: 700, marginBottom: "4px" }}>Access &amp; Permissions</h1>
      <p style={{ fontSize: "12px", color: T.muted, marginBottom: "20px" }}>
        Who can sign in, what each role may view or edit, and revocation. Revoking takes effect on the
        next request — it blocks the API and the page, not just the navigation.
      </p>

      {error && (
        <div style={{ ...card, borderColor: T.red, color: T.red, fontSize: "13px" }}>{error}</div>
      )}

      {data && (
        <>
          <div style={card}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "8px" }}>Roles</div>
            <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ color: T.muted, textAlign: "left" }}>
                  <th style={{ padding: "6px 10px 6px 0" }}>Role</th>
                  <th style={{ padding: "6px 10px 6px 0" }}>Can view</th>
                  <th style={{ padding: "6px 10px 6px 0" }}>Can edit</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ padding: "8px 10px 8px 0", fontWeight: 700, color: T.accent }}>
                    owner<div style={{ fontSize: "11px", fontWeight: 400, color: T.muted }}>{data.owner.email}</div>
                  </td>
                  <td style={{ padding: "8px 10px 8px 0" }}>{data.owner.access.pages.join(", ")}</td>
                  <td style={{ padding: "8px 10px 8px 0", color: T.green, fontWeight: 600 }}>Yes — everything</td>
                </tr>
                <tr style={{ borderTop: `1px solid ${T.border}` }}>
                  <td style={{ padding: "8px 10px 8px 0", fontWeight: 700 }}>viewer</td>
                  <td style={{ padding: "8px 10px 8px 0" }}>
                    {data.viewer_pages.map((p) => (
                      <div key={p} style={{ fontFamily: "monospace", fontSize: "11px" }}>{p}</div>
                    ))}
                  </td>
                  <td style={{ padding: "8px 10px 8px 0", color: T.red, fontWeight: 600 }}>No — read only</td>
                </tr>
              </tbody>
            </table>
            <div style={{ fontSize: "11px", color: T.muted, marginTop: "10px", lineHeight: 1.5 }}>
              {data.viewer_access.notes}
            </div>
          </div>

          <div style={card}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>
              Granted accounts ({data.grants.filter((g) => g.active).length} active of {data.grants.length})
            </div>
            {data.grants.length === 0 ? (
              <div style={{ fontSize: "12px", color: T.muted }}>
                No guest accounts. Only {data.owner.email} can sign in.
              </div>
            ) : (
              <table style={{ width: "100%", fontSize: "12px", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ color: T.muted, textAlign: "left" }}>
                    <th style={{ padding: "6px 10px 6px 0" }}>Email</th>
                    <th style={{ padding: "6px 10px 6px 0" }}>Role</th>
                    <th style={{ padding: "6px 10px 6px 0" }}>Status</th>
                    <th style={{ padding: "6px 10px 6px 0" }}>Granted</th>
                    <th style={{ padding: "6px 0" }} />
                  </tr>
                </thead>
                <tbody>
                  {data.grants.map((g) => (
                    <tr key={g.user_id} style={{ borderTop: `1px solid ${T.border}` }}>
                      <td style={{ padding: "8px 10px 8px 0" }}>{g.email}</td>
                      <td style={{ padding: "8px 10px 8px 0" }}>{g.role}</td>
                      <td style={{ padding: "8px 10px 8px 0", color: g.active ? T.green : T.muted, fontWeight: 600 }}>
                        {g.active ? "Active" : `Revoked ${g.revoked_at?.slice(0, 10)}`}
                      </td>
                      <td style={{ padding: "8px 10px 8px 0", color: T.muted }}>{g.granted_at?.slice(0, 10)}</td>
                      <td style={{ padding: "8px 0", textAlign: "right" }}>
                        <button
                          onClick={() => act(g.user_id, g.active ? "revoke" : "restore")}
                          disabled={busy === g.user_id}
                          style={{
                            background: "transparent", cursor: "pointer",
                            border: `1px solid ${g.active ? T.red : T.green}`,
                            color: g.active ? T.red : T.green,
                            borderRadius: "6px", padding: "4px 12px", fontSize: "11px", fontWeight: 600,
                          }}
                        >
                          {busy === g.user_id ? "…" : g.active ? "Revoke" : "Restore"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
