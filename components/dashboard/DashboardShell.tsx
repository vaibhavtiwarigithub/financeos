"use client";
import { useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280",
  accent: "#6366F1", green: "#34D399", red: "#F87171", yellow: "#FBBF24",
};

const NAV = [
  { href: "/dashboard", label: "Home", icon: "⌂" },
  { href: "/dashboard/portfolio", label: "Portfolio", icon: "◈" },
  { href: "/dashboard/markets", label: "Markets", icon: "◉" },
  { href: "/dashboard/intelligence", label: "Intelligence", icon: "◆" },
  { href: "/dashboard/calendar", label: "Calendar", icon: "▦" },
  { href: "/dashboard/you", label: "You", icon: "◎" },
  { href: "/dashboard/settings", label: "Settings", icon: "⚙" },
];

const ADMIN_NAV = { href: "/dashboard/admin", label: "Admin", icon: "★" };

const TIER_COLORS: Record<string, string> = { free: T.muted, pro: T.accent, elite: T.yellow };

export default function DashboardShell({ profile, children }: { profile: Profile; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const navItems = [...NAV, ...(["admin", "superadmin"].includes(profile.role) ? [ADMIN_NAV] : [])];

  return (
    <div style={{ display: "flex", minHeight: "100vh", background: T.bg, fontFamily: "'Inter', sans-serif", color: T.text }}>

      {/* Sidebar */}
      <aside style={{ width: "220px", background: T.surface, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", position: "sticky", top: 0, height: "100vh", flexShrink: 0 }}>
        {/* Logo */}
        <div style={{ padding: "20px 20px 16px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: "17px", fontWeight: 700, letterSpacing: "-0.02em" }}>
            Finance<span style={{ color: T.accent }}>OS</span>
          </div>
          <div style={{ fontSize: "10px", color: T.muted, marginTop: "2px", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            Intelligence Platform
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, padding: "12px 10px", overflowY: "auto" }}>
          {navItems.map(item => {
            const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
            return (
              <button key={item.href} onClick={() => router.push(item.href)} style={{
                width: "100%", display: "flex", alignItems: "center", gap: "10px",
                padding: "9px 12px", borderRadius: "8px", border: "none",
                background: active ? T.accent + "18" : "none",
                color: active ? T.accent : T.textSub,
                fontSize: "14px", fontWeight: active ? 500 : 400,
                cursor: "pointer", textAlign: "left", marginBottom: "2px",
                borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent",
              }}>
                <span style={{ fontSize: "14px", width: "18px", textAlign: "center" }}>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* User profile */}
        <div style={{ padding: "14px", borderTop: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" style={{ width: "32px", height: "32px", borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: "32px", height: "32px", borderRadius: "50%", background: T.accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "13px", fontWeight: 600 }}>
                {(profile.full_name || profile.email)[0].toUpperCase()}
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: "13px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {profile.full_name || profile.email.split("@")[0]}
              </div>
              <div style={{ fontSize: "10px", color: TIER_COLORS[profile.subscription_tier], textTransform: "uppercase", fontWeight: 600 }}>
                {profile.subscription_tier}
              </div>
            </div>
          </div>
          <button onClick={signOut} style={{ width: "100%", background: "none", border: `1px solid ${T.border}`, borderRadius: "6px", color: T.muted, padding: "7px", fontSize: "12px", cursor: "pointer" }}>
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: "auto", minWidth: 0 }}>
        {children}
      </main>
    </div>
  );
}
