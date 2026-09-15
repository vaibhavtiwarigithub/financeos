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
  note: string | null;
  /** "not revoked" — NOT "has access". Kept for the revoke/restore button only. */
  active: boolean;
  status: "active" | "pending" | "revoked";
  accepted: boolean;
  can_sign_in: boolean;
  status_label: string;
  status_tone: "good" | "warn" | "bad" | "muted";
  delivery_problem: string | null;
};
// The page's whole job is answering "who can see my book?", so a grant that
// nobody has accepted must not look like one that someone is using. Colour
// carries that distinction before the text is read.
const TONE: Record<Grant["status_tone"], string> = {
  good: T.green, warn: T.amber, bad: T.red, muted: T.muted,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/access", { cache: "no-store" });
      if (!res.ok) { setError(`Failed to load (${res.status})`); return; }
      setData(await res.json());
      setError(null);
    } catch (e: any) { setError(String(e?.message ?? e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    if (!confirm(`Send a viewer invitation to ${email}?\n\nThey will receive an email to set their own password, and will be able to see the owner's Paper Portfolio and Fundamentals — read only.`)) return;
    setInviting(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "invite", email }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json?.error ?? `Invite failed (${res.status})`); return; }
      setError(null);
      // BOTH branches send mail. This used to claim "no email sent" for a
      // returning address, which was simply untrue — the route mints a recovery
      // link and mails it, which is exactly how a revoked person is restored.
      //
      // And neither branch means they have access yet: the provider has ACCEPTED
      // the message, which is not delivery, and they still have to open it. If
      // the address is dead the bounce lands in the table below within a few
      // minutes. Saying "access granted" here is what made a typo invisible.
      setNotice(
        (json.invited_new_account
          ? `Invitation sent to ${email}.`
          : `${email} already had an account — a sign-in link was emailed to them.`)
        + " They appear below as awaiting acceptance until they open it; if the address is dead, the row turns red within a few minutes."
      );
      setInviteEmail("");
      await load();
    } finally { setInviting(false); }
  }

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
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Invite a viewer</div>
            <div style={{ fontSize: "11px", color: T.muted, marginBottom: "10px", lineHeight: 1.5 }}>
              They receive an email and set their own password — no password is ever entered here.
              Access is read-only and can be revoked below at any time.
            </div>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                placeholder="friend@example.com"
                style={{
                  flex: "1 1 260px", background: T.bg, border: `1px solid ${T.border}`,
                  borderRadius: "6px", color: T.text, padding: "7px 10px", fontSize: "12px",
                }}
              />
              <button
                onClick={sendInvite}
                disabled={inviting || !inviteEmail.trim()}
                style={{
                  background: inviting || !inviteEmail.trim() ? T.card : T.accent,
                  border: "none", borderRadius: "6px",
                  color: inviting || !inviteEmail.trim() ? T.muted : "#fff",
                  padding: "7px 16px", fontSize: "12px", fontWeight: 600,
                  cursor: inviting || !inviteEmail.trim() ? "default" : "pointer",
                }}
              >
                {inviting ? "Sending…" : "Send invitation"}
              </button>
            </div>
            {notice && (
              <div style={{ fontSize: "11px", color: T.green, marginTop: "10px" }}>{notice}</div>
            )}
          </div>

          <div style={card}>
            <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "10px" }}>
              Granted accounts ({data.grants.filter((g) => g.can_sign_in).length} with access
              {data.grants.some((g) => g.status === "pending") &&
                `, ${data.grants.filter((g) => g.status === "pending").length} awaiting acceptance`}
              {data.grants.some((g) => g.delivery_problem) &&
                `, ${data.grants.filter((g) => g.delivery_problem).length} undeliverable`}
              , {data.grants.length} total)
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
                      <td style={{ padding: "8px 10px 8px 0", color: TONE[g.status_tone], fontWeight: 600 }}>
                        {g.status_label}
                        {g.delivery_problem && (
                          <div style={{ fontSize: "11px", fontWeight: 400, color: T.red, marginTop: "3px", maxWidth: "260px", lineHeight: 1.4 }}>
                            {g.delivery_problem}
                          </div>
                        )}
                        {g.status === "pending" && !g.delivery_problem && (
                          <div style={{ fontSize: "11px", fontWeight: 400, color: T.muted, marginTop: "3px" }}>
                            They cannot sign in until they open the invitation.
                          </div>
                        )}
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
