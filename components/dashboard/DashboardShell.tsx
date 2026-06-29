"use client";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/types";
import StatusBar from "./StatusBar";

type NavItem = { href: string; label: string; icon: string };
type NavGroup = { section: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    section: "Monitor",
    items: [
      { href: "/dashboard",             label: "Home",         icon: "⌂" },
      { href: "/dashboard/activity",    label: "Activity",     icon: "◷" },
      { href: "/dashboard/markets",     label: "Markets",      icon: "◉" },
    ],
  },
  {
    section: "Agents",
    items: [
      { href: "/dashboard/agents",       label: "Agents",      icon: "◐" },
      { href: "/dashboard/intelligence", label: "Research",    icon: "◆" },
      { href: "/dashboard/learning",     label: "Learning",    icon: "◫" },
      { href: "/dashboard/mentor",       label: "Mentor",      icon: "◉" },
    ],
  },
  {
    section: "Portfolio",
    items: [
      { href: "/dashboard/portfolio",   label: "Portfolio",    icon: "◈" },
      { href: "/dashboard/trading",     label: "Trading",      icon: "◑" },
      { href: "/dashboard/calendar",    label: "Calendar",     icon: "▦" },
    ],
  },
  {
    section: "",
    items: [
      { href: "/dashboard/you",         label: "You",          icon: "◎" },
      { href: "/dashboard/settings",    label: "Settings",     icon: "⚙" },
    ],
  },
];

const ADMIN_NAV: NavItem = { href: "/dashboard/admin", label: "Admin", icon: "★" };

export default function DashboardShell({ profile, children }: { profile: Profile; children: React.ReactNode }) {
  const router   = useRouter();
  const pathname = usePathname();
  const supabase = createClient();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const groups = NAV_GROUPS.map(g => ({ ...g, items: [...g.items] }));
  if (["admin", "superadmin"].includes(profile.role)) {
    groups[groups.length - 1].items.push(ADMIN_NAV);
  }
  const tierColor = profile.subscription_tier === "elite"
    ? "var(--fo-amber)"
    : profile.subscription_tier === "pro"
    ? "var(--fo-accent)"
    : "var(--fo-text-muted)";

  return (
    <div className="flex min-h-screen" style={{ background: "var(--fo-bg-primary)", color: "var(--fo-text-primary)", fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Sidebar */}
      <aside
        className="w-[220px] shrink-0 flex flex-col sticky top-0 h-screen"
        style={{ background: "var(--fo-bg-surface)", borderRight: "1px solid var(--fo-border-solid)" }}
      >
        {/* Logo */}
        <div className="px-5 pt-5 pb-4" style={{ borderBottom: "1px solid var(--fo-border-solid)" }}>
          <div className="text-[17px] font-bold tracking-tight">
            Finance<span style={{ color: "var(--fo-accent)" }}>OS</span>
          </div>
          <div className="text-[10px] mt-0.5 uppercase tracking-widest" style={{ color: "var(--fo-text-muted)" }}>
            Intelligence Platform
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2.5 py-3 overflow-y-auto">
          {groups.map((group, gi) => (
            <div key={gi} style={{ marginBottom: "4px" }}>
              {group.section && (
                <div style={{
                  fontSize: "9px", fontWeight: 700, letterSpacing: "0.12em",
                  textTransform: "uppercase", color: "var(--fo-text-muted)",
                  padding: "10px 12px 4px", opacity: 0.6,
                }}>
                  {group.section}
                </div>
              )}
              {!group.section && gi > 0 && (
                <div style={{ height: "1px", background: "var(--fo-border-solid)", margin: "8px 4px 10px" }} />
              )}
              {group.items.map(item => {
                const active = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href));
                return (
                  <button
                    key={item.href}
                    onClick={() => router.push(item.href)}
                    className="w-full flex items-center gap-2.5 px-3 py-[9px] rounded-lg text-[14px] mb-0.5 text-left cursor-pointer transition-colors"
                    style={{
                      background:  active ? "rgba(99,102,241,0.10)" : "transparent",
                      color:       active ? "var(--fo-accent)" : "var(--fo-text-secondary)",
                      fontWeight:  active ? 500 : 400,
                      border:      "none",
                      borderLeft:  `2px solid ${active ? "var(--fo-accent)" : "transparent"}`,
                    }}
                  >
                    <span className="w-[18px] text-center text-[14px]">{item.icon}</span>
                    {item.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Account status */}
        <div style={{ padding: "8px 12px", borderTop: "1px solid var(--fo-border-solid)", fontSize: "10px", color: "var(--fo-text-muted)" }}>
          <div style={{ marginBottom: "4px", fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", opacity: 0.5 }}>Accounts</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "3px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>Paper portfolio</span>
              <span style={{ color: "#FBBF24", fontWeight: 600 }}>PAPER</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>••••8641</span>
              <span style={{ color: "#60A5FA", fontWeight: 600 }}>READ-ONLY</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>••••0660</span>
              <span style={{ color: "#F87171", fontWeight: 600 }}>ORDERS</span>
            </div>
          </div>
        </div>

        {/* User */}
        <div className="p-3.5" style={{ borderTop: "1px solid var(--fo-border-solid)" }}>
          <div className="flex items-center gap-2.5 mb-2.5">
            {profile.avatar_url ? (
              <img src={profile.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-[13px] font-semibold text-white shrink-0"
                style={{ background: "var(--fo-accent)" }}
              >
                {(profile.full_name || profile.email)[0].toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-medium truncate" style={{ color: "var(--fo-text-primary)" }}>
                {profile.full_name || profile.email.split("@")[0]}
              </div>
              <div className="text-[10px] uppercase font-semibold" style={{ color: tierColor }}>
                {profile.subscription_tier}
              </div>
            </div>
          </div>
          <button
            onClick={signOut}
            className="w-full rounded text-xs py-1.5 cursor-pointer transition-colors hover:opacity-80"
            style={{ background: "none", border: "1px solid var(--fo-border-solid)", color: "var(--fo-text-muted)" }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto min-w-0" style={{ paddingBottom: "32px" }}>
        {children}
      </main>

      <StatusBar />
    </div>
  );
}
