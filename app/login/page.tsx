"use client";
import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";

// Google sign-in is disabled for now (no email gate on that path) — flip
// this back to true to re-enable once it's wired to the same restriction
// middleware.ts enforces server-side.
const GOOGLE_SIGNIN_ENABLED = false;

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171",
};

const inp: React.CSSProperties = {
  width: "100%", background: "#13151C", border: `1px solid ${T.border}`,
  borderRadius: "8px", color: T.text, fontSize: "14px",
  padding: "11px 14px", outline: "none", boxSizing: "border-box",
};

export default function LoginPage() {
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("error") === "restricted") {
      setError("This account isn't authorized for this app.");
    }
  }, []);

  async function handleGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) { setError(error.message ?? "Google sign-in failed"); setLoading(false); }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");
    if (email !== "vterminater@gmail.com") {
      setError("Access restricted.");
      setLoading(false);
      return;
    }
    // Recovery links use Supabase's own token format (hash fragment or
    // token_hash, not the ?code= PKCE param /auth/callback expects) — send
    // straight to /reset-password, which listens for the PASSWORD_RECOVERY
    // auth event instead of trying to exchange a code.
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) setError(error.message ?? "Could not send reset email");
    else setSuccess("Password reset link sent — check your email.");
    setLoading(false);
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");
    if (email !== "vterminater@gmail.com") {
      setError("Access restricted.");
      setLoading(false);
      return;
    }
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) setError(error.message ?? "Signup failed");
      else setSuccess("Account created — check email to confirm, or sign in directly if confirmation is disabled.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message ?? "Sign in failed");
      else window.location.href = "/dashboard";
    }
    setLoading(false);
  }

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: T.text, display: "flex", flexDirection: "column" }}>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: "18px", fontWeight: 700, letterSpacing: "-0.02em" }}>
          Finance<span style={{ color: T.accent }}>OS</span>
        </div>
      </div>

      {/* Center card */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px" }}>
        <div style={{ width: "100%", maxWidth: "400px" }}>

          <div style={{ textAlign: "center", marginBottom: "32px" }}>
            <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "10px" }}>
              Intelligence Platform
            </div>
            <h1 style={{ fontSize: "28px", fontWeight: 700, letterSpacing: "-0.02em" }}>
              {mode === "signin" ? "Welcome back" : mode === "signup" ? "Create account" : "Reset password"}
            </h1>
          </div>

          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "32px" }}>

            {mode !== "forgot" && GOOGLE_SIGNIN_ENABLED && (
              <>
                {/* Google */}
                <button
                  onClick={handleGoogle}
                  disabled={loading}
                  style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", color: T.text, padding: "12px", fontSize: "14px", fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "20px" }}
                >
                  <svg width="18" height="18" viewBox="0 0 48 48">
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                  </svg>
                  Continue with Google
                </button>

                <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
                  <div style={{ flex: 1, height: "1px", background: T.border }} />
                  <span style={{ fontSize: "12px", color: T.muted }}>or</span>
                  <div style={{ flex: 1, height: "1px", background: T.border }} />
                </div>
              </>
            )}

            {mode === "forgot" ? (
              <form onSubmit={handleForgotPassword}>
                <p style={{ fontSize: "13px", color: T.textSub, marginBottom: "16px" }}>
                  Enter your email and we'll send you a link to reset your password.
                </p>
                <div style={{ marginBottom: "20px" }}>
                  <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Email</label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={inp} required />
                </div>

                {error && (
                  <div style={{ background: "#3B0000", border: `1px solid ${T.red}`, borderRadius: "8px", padding: "10px 14px", color: T.red, fontSize: "13px", marginBottom: "16px" }}>
                    {error}
                  </div>
                )}
                {success && (
                  <div style={{ background: "#052E16", border: `1px solid ${T.green}`, borderRadius: "8px", padding: "10px 14px", color: T.green, fontSize: "13px", marginBottom: "16px" }}>
                    {success}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  style={{ width: "100%", background: T.accent, border: "none", borderRadius: "10px", color: "#fff", padding: "13px", fontSize: "15px", fontWeight: 600, cursor: "pointer", opacity: loading ? 0.7 : 1 }}
                >
                  {loading ? "Sending..." : "Send reset link"}
                </button>
              </form>
            ) : (
            <form onSubmit={handleEmail}>
              <div style={{ marginBottom: "14px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={inp} required />
              </div>
              <div style={{ marginBottom: "10px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} />
              </div>
              {mode === "signin" && (
                <div style={{ textAlign: "right", marginBottom: "16px" }}>
                  <button
                    type="button"
                    onClick={() => { setMode("forgot"); setError(""); setSuccess(""); }}
                    style={{ background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: "12px" }}
                  >
                    Forgot password?
                  </button>
                </div>
              )}

              {error && (
                <div style={{ background: "#3B0000", border: `1px solid ${T.red}`, borderRadius: "8px", padding: "10px 14px", color: T.red, fontSize: "13px", marginBottom: "16px" }}>
                  {error}
                </div>
              )}
              {success && (
                <div style={{ background: "#052E16", border: `1px solid ${T.green}`, borderRadius: "8px", padding: "10px 14px", color: T.green, fontSize: "13px", marginBottom: "16px" }}>
                  {success}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{ width: "100%", background: T.accent, border: "none", borderRadius: "10px", color: "#fff", padding: "13px", fontSize: "15px", fontWeight: 600, cursor: "pointer", opacity: loading ? 0.7 : 1 }}
              >
                {loading ? "Loading..." : mode === "signin" ? "Sign In" : "Create Account"}
              </button>
            </form>
            )}

            <p style={{ fontSize: "12px", color: T.muted, textAlign: "center", marginTop: "20px" }}>
              {mode === "forgot" ? (
                <button
                  onClick={() => { setMode("signin"); setError(""); setSuccess(""); }}
                  style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: "12px" }}
                >
                  ← Back to sign in
                </button>
              ) : (
                <>
                  {mode === "signin" ? "Need an account? " : "Already have one? "}
                  <button
                    onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(""); setSuccess(""); }}
                    style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: "12px" }}
                  >
                    {mode === "signin" ? "Sign up" : "Sign in"}
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
