"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

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

// Reached only via the reset-password email link, which /auth/callback
// exchanges for a real session before redirecting here — updateUser works
// against that session, no separate token handling needed.
export default function ResetPasswordPage() {
  const supabase = createClient();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) { setError("Passwords don't match"); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters"); return; }

    setLoading(true);
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
        </div>
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "32px" }}>
          {success ? (
            <div style={{ background: "#052E16", border: `1px solid ${T.green}`, borderRadius: "8px", padding: "14px", color: T.green, fontSize: "13px", textAlign: "center" }}>
              Password updated — redirecting to dashboard...
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "14px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>New password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} />
              </div>
              <div style={{ marginBottom: "20px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Confirm password</label>
                <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} />
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
