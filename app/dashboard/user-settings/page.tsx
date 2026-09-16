"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/dashboard/PageHeader";
import { useRole } from "@/lib/auth/use-role";

// The daily-risk-email and newsletter toggles were REMOVED from this page on
// 2026-09-16. Both saved correctly and neither did anything a user would notice:
//
//   • Newsletter: `supabase/functions/newsletter-daily` sends to one hardcoded
//     RECIPIENT and never reads `user_notification_prefs.newsletter_opted_in`.
//     Opting in subscribed nobody and opting out unsubscribed nobody.
//   • Daily risk email: the pipeline is real (`user_risk_email_prefs` +
//     the hourly `kairos-user-risk-email` cron, which honours send_hour_utc),
//     but it can only mail the Resend account owner until a verified domain or
//     SMTP transport is configured, and it needs a connected broker before there
//     is any risk run to summarise. A guest enabling it would have received
//     nothing, with no way to tell why.
//
// A switch that silently does nothing is worse than no switch, so the promise is
// withdrawn until the thing behind it works. The preference rows and
// /api/user-prefs are untouched — restoring the UI is the only step needed.

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

export default function UserSettingsPage() {
  const role = useRole();
  const router = useRouter();

  useEffect(() => {
    if (role === null) router.replace("/login");
  }, [role, router]);

  if (role === undefined) {
    return (
      <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: T.muted, fontSize: "14px" }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, fontFamily: "Inter, sans-serif" }}>
      <PageHeader
        title="My Settings"
        whatItDoes="Connect your own broker account so the app can show risk analytics for your holdings."
        whatToLookFor={[
          "Connect Zerodha or Robinhood to see risk analytics for your own positions.",
          "Your broker credentials are encrypted and only ever used for your own account.",
          "Nothing here exposes or changes the owner's portfolio.",
        ]}
      />
      <div style={{ maxWidth: "600px", margin: "0 auto", padding: "32px 16px", display: "flex", flexDirection: "column", gap: "24px" }}>

        {/* Broker Connections */}
        <section style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "24px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, color: T.textSub, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: "16px" }}>
            Connected Brokers
          </div>
          <div style={{ fontSize: "14px", color: T.textSub, marginBottom: "16px" }}>
            Connect your own Zerodha or Robinhood account to see personalized risk analytics.
          </div>
          <button
            onClick={() => router.push("/dashboard/connections")}
            style={{
              background: T.accent, color: T.text, border: "none", borderRadius: "8px",
              padding: "10px 20px", fontSize: "14px", fontWeight: 500, cursor: "pointer",
            }}
          >
            Manage connections →
          </button>
        </section>

        <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.6 }}>
          Email preferences will return here once outbound email is configured for guest accounts.
        </div>

      </div>
    </div>
  );
}
