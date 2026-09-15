"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { establishEmailLinkSession, parseEmailLink, safeNextPath, SIGN_IN_LINK_TYPES } from "@/lib/auth/email-link";

const T = { bg: "#0D0F14", card: "#1A1D27", border: "#252836", text: "#ECEDEF", muted: "#6B7280", accent: "#6366F1", red: "#F87171" };

// Landing page for one-time sign-in links (the owner's "Resend email").
// It signs in as the account the link proves — replacing any session this
// browser already had — and only then continues. See lib/auth/email-link.ts.
export default function ConfirmEmailLinkPage() {
  const [supabase] = useState(() => createClient());
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (started.current) return; // a one-time token must not be spent twice
    started.current = true;
    const link = parseEmailLink(window.location.search, window.location.hash);
    const next = safeNextPath(new URLSearchParams(window.location.search).get("next"), "/dashboard");
    // Remove the token from the address bar and history straight away.
    if (link.kind !== "none") window.history.replaceState(null, "", window.location.pathname);
    establishEmailLinkSession(supabase, link, SIGN_IN_LINK_TYPES).then((r) => {
      if (r.ok) router.replace(next);
      else setError(r.reason);
    });
  }, [supabase, router]);

  return (
    <div style={{ background: T.bg, minHeight: "100vh", fontFamily: "'Inter', sans-serif", color: T.text, display: "flex", alignItems: "center", justifyContent: "center", padding: "24px" }}>
      <div style={{ width: "100%", maxWidth: "400px", background: T.card, border: `1px solid ${T.border}`, borderRadius: "16px", padding: "32px", textAlign: "center" }}>
        {error ? (
          <>
            <div style={{ background: "#3B0000", border: `1px solid ${T.red}`, borderRadius: "8px", padding: "14px", color: T.red, fontSize: "13px", marginBottom: "16px", lineHeight: 1.5 }}>{error}</div>
            <a href="/login" style={{ color: T.accent, fontSize: "13px", textDecoration: "none" }}>← Back to sign in</a>
          </>
        ) : (
          <div style={{ color: T.muted, fontSize: "13px" }}>Signing you in…</div>
        )}
      </div>
    </div>
  );
}
