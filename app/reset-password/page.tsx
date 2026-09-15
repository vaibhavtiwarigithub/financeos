"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { establishEmailLinkSession, parseEmailLink, SET_PASSWORD_LINK_TYPES } from "@/lib/auth/email-link";

const T = {
  bg: "#0D0F14", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171",
};

const inp: React.CSSProperties = {
  width: "100%", background: "#13151C", border: `1px solid ${T.border}`,
  borderRadius: "8px", color: T.text, fontSize: "14px",
  padding: "11px 14px", outline: "none", boxSizing: "border-box",
};

// Reached from an invitation or password-recovery email.
//
// The form appears only for the account the LINK proves, never for a session
// the browser already had. The previous version showed the form whenever
// `getSession()` found anything, so opening a viewer's invite while signed in as
// the owner changed the OWNER's password (production, 2026-09-15). See
// lib/auth/email-link.ts.
export default function ResetPasswordPage() {
  const [supabase] = useState(() => createClient());
  const router = useRouter();
  const started = useRef(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [checking, setChecking] = useState(true);
  const [linkError, setLinkError] = useState("");
  const [target, setTarget] = useState<{ userId: string; email: string } | null>(null);

  useEffect(() => {
    if (started.current) return; // a one-time token must not be spent twice
    started.current = true;
    const link = parseEmailLink(window.location.search, window.location.hash);
    // Remove the token from the address bar and history straight away.
    if (link.kind !== "none") window.history.replaceState(null, "", window.location.pathname);
    establishEmailLinkSession(supabase, link, SET_PASSWORD_LINK_TYPES).then((r) => {
      if (r.ok) setTarget({ userId: r.userId, email: r.email });
      else setLinkError(r.reason);
      setChecking(false);
    });
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!target) return;
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }

    setLoading(true);
    // Another tab could have signed in as someone else since the link was
    // opened. Change the password only if this is still the link's account.
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || user.id !== target.userId) {
      setLoading(false);
      setError(`This window is no longer signed in as ${target.email}, so nothing was changed. Open the link from your email again.`);
      return;
    }
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) { setError(error.message ?? "Could not update password"); return; }
    setSuccess(true);
    setTimeout(() => router.push("/dashboard"), 1500);
  }

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: T.text, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: "400px" }}>
        <div style={{ textAlign: "center", marginBottom: "32px" }}>
          <h1 style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "-0.02em" }}>Set new password</h1>
          {target && (
            <div style={{ color: T.textSub, fontSize: "14px", marginTop: "8px" }}>
              for <strong style={{ color: T.text }}>{target.email}</strong>
            </div>
          )}
        </div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "32px" }}>
          {checking ? (
            <div style={{ color: T.muted, fontSize: "13px", textAlign: "center" }}>Verifying link...</div>
          ) : !target ? (
            <div style={{ textAlign: "center" }}>
              <div style={{ background: "#3B0000", border: `1px solid ${T.red}`, borderRadius: "8px", padding: "14px", color: T.red, fontSize: "13px", marginBottom: "16px", lineHeight: 1.5 }}>
                {linkError || "This link is invalid or expired."}
              </div>
              <a href="/login" style={{ color: T.accent, fontSize: "13px", textDecoration: "none" }}>← Back to sign in</a>
            </div>
          ) : success ? (
            <div style={{ background: "#052E16", border: `1px solid ${T.green}`, borderRadius: "8px", padding: "14px", color: T.green, fontSize: "13px", textAlign: "center" }}>
              Password updated for {target.email} — redirecting...
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div style={{ color: T.muted, fontSize: "12px", marginBottom: "16px", lineHeight: 1.5 }}>
                You are setting the password for {target.email}. If that is not the account you expected, close this page.
              </div>
              <div style={{ marginBottom: "14px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>New password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} autoComplete="new-password" />
              </div>
              <div style={{ marginBottom: "20px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Confirm password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} autoComplete="new-password" />
              </div>

              {error && (
                <div style={{ background: "#3B0000", border: `1px solid ${T.red}`, borderRadius: "8px", padding: "10px 14px", color: T.red, fontSize: "13px", marginBottom: "16px" }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{ width: "100%", background: T.accent, border: "none", borderRadius: "10px", color: "#fff", padding: "13px", fontSize: "15px", fontWeight: 600, cursor: "pointer", opacity: loading ? 0.7 : 1 }}
              >
                {loading ? "Updating..." : "Update password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
