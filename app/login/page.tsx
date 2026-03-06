"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { SUBSCRIPTION_PLANS } from "@/types";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", blue: "#60A5FA",
};

export default function LoginPage() {
  const supabase = createClient();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function handleGoogle() {
    setLoading(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) { setError(error.message); setLoading(false); }
  }

  async function handleEmail(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setSuccess("");
    if (mode === "signup") {
      const { error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name }, emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) setError(error.message);
      else setSuccess("Check your email to confirm your account.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError(error.message);
      else window.location.href = "/dashboard";
    }
    setLoading(false);
  }

  const inp: React.CSSProperties = {
    width: "100%", background: "#13151C", border: `1px solid ${T.border}`,
    borderRadius: "8px", color: T.text, fontSize: "14px",
    padding: "11px 14px", outline: "none",
  };

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: T.text }}>

      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "16px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: "18px", fontWeight: 700, letterSpacing: "-0.02em" }}>
          Finance<span style={{ color: T.accent }}>OS</span>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <button onClick={() => setMode("signin")} style={{ background: mode === "signin" ? T.accent : "none", border: `1px solid ${mode === "signin" ? T.accent : T.border}`, borderRadius: "8px", color: T.text, padding: "8px 20px", fontSize: "14px", cursor: "pointer" }}>Sign In</button>
          <button onClick={() => setMode("signup")} style={{ background: mode === "signup" ? T.accent : "none", border: `1px solid ${mode === "signup" ? T.accent : T.border}`, borderRadius: "8px", color: T.text, padding: "8px 20px", fontSize: "14px", cursor: "pointer" }}>Sign Up</button>
        </div>
      </div>

      <div style={{ maxWidth: "1100px", margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: "60px" }}>
          <div style={{ fontSize: "11px", color: T.accent, letterSpacing: "0.15em", textTransform: "uppercase", marginBottom: "12px" }}>AI-Powered Financial Intelligence</div>
          <h1 style={{ fontSize: "42px", fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.15, marginBottom: "16px" }}>
            Your personal<br /><span style={{ color: T.accent }}>market command center</span>
          </h1>
          <p style={{ fontSize: "16px", color: T.textSub, maxWidth: "500px", margin: "0 auto" }}>
            US & India markets. Real-time AI analysis. Portfolio tracking. Prediction scoring. Built to make you a better investor.
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "60px", alignItems: "start" }}>

          {/* Auth Card */}
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "36px" }}>
            <h2 style={{ fontSize: "20px", fontWeight: 600, marginBottom: "24px" }}>
              {mode === "signin" ? "Welcome back" : "Create your account"}
            </h2>

            {/* Google */}
            <button onClick={handleGoogle} disabled={loading} style={{ width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: "10px", color: T.text, padding: "12px", fontSize: "14px", fontWeight: 500, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: "10px", marginBottom: "20px" }}>
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.36-8.16 2.36-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
              Continue with Google
            </button>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "20px" }}>
              <div style={{ flex: 1, height: "1px", background: T.border }} />
              <span style={{ fontSize: "12px", color: T.muted }}>or</span>
              <div style={{ flex: 1, height: "1px", background: T.border }} />
            </div>

            <form onSubmit={handleEmail}>
              {mode === "signup" && (
                <div style={{ marginBottom: "14px" }}>
                  <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Full name</label>
                  <input value={name} onChange={e => setName(e.target.value)} placeholder="Your name" style={inp} required />
                </div>
              )}
              <div style={{ marginBottom: "14px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Email</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" style={inp} required />
              </div>
              <div style={{ marginBottom: "24px" }}>
                <label style={{ fontSize: "13px", color: T.textSub, display: "block", marginBottom: "6px" }}>Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={inp} required minLength={6} />
              </div>

              {error && <div style={{ background: "#3B0000", border: "1px solid #F87171", borderRadius: "8px", padding: "10px 14px", color: T.red, fontSize: "13px", marginBottom: "16px" }}>{error}</div>}
              {success && <div style={{ background: "#052E16", border: "1px solid #34D399", borderRadius: "8px", padding: "10px 14px", color: T.green, fontSize: "13px", marginBottom: "16px" }}>{success}</div>}

              <button type="submit" disabled={loading} style={{ width: "100%", background: T.accent, border: "none", borderRadius: "10px", color: "#fff", padding: "13px", fontSize: "15px", fontWeight: 600, cursor: "pointer", opacity: loading ? 0.7 : 1 }}>
                {loading ? "Loading..." : mode === "signin" ? "Sign In" : "Create Account"}
              </button>
            </form>

            <p style={{ fontSize: "12px", color: T.muted, textAlign: "center", marginTop: "20px" }}>
              {mode === "signin" ? "No account? " : "Already have one? "}
              <button onClick={() => setMode(mode === "signin" ? "signup" : "signin")} style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", fontSize: "12px" }}>
                {mode === "signin" ? "Sign up free" : "Sign in"}
              </button>
            </p>
          </div>

          {/* Pricing */}
          <div>
            <h3 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "20px", color: T.textSub }}>Choose your plan</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              {SUBSCRIPTION_PLANS.map(plan => (
                <div key={plan.tier} style={{ background: plan.popular ? T.accent + "12" : T.card, border: `1px solid ${plan.popular ? T.accent + "60" : T.border}`, borderRadius: "12px", padding: "20px", position: "relative" }}>
                  {plan.popular && <div style={{ position: "absolute", top: "12px", right: "16px", background: T.accent, color: "#fff", fontSize: "10px", fontWeight: 700, padding: "3px 10px", borderRadius: "20px", letterSpacing: "0.05em" }}>POPULAR</div>}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "10px" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "15px" }}>{plan.name}</div>
                      <div style={{ fontSize: "12px", color: T.muted, marginTop: "2px" }}>{plan.description}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span style={{ fontSize: "22px", fontWeight: 700, color: plan.popular ? T.accent : T.text }}>${plan.price}</span>
                      {plan.price > 0 && <span style={{ fontSize: "11px", color: T.muted }}>/mo</span>}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {plan.features.slice(0, 4).map(f => (
                      <span key={f} style={{ fontSize: "11px", color: T.textSub, background: T.surface, padding: "2px 8px", borderRadius: "4px" }}>✓ {f}</span>
                    ))}
                    {plan.features.length > 4 && <span style={{ fontSize: "11px", color: T.muted }}>+{plan.features.length - 4} more</span>}
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: "11px", color: T.muted, marginTop: "16px", textAlign: "center" }}>
              Start free. Upgrade anytime. Cancel anytime.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
