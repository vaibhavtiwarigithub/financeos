"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Database, LayoutDashboard, Map, ArrowLeftRight } from "lucide-react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", blue: "#60A5FA",
};

const nav = [
  { href: "/property", label: "Overview", icon: LayoutDashboard },
  { href: "/property/markets", label: "Market Explorer", icon: Map },
  { href: "/property/sources", label: "Data Sources", icon: Database },
];

export default function PropertyShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div style={{ minHeight: "100vh", background: T.bg, color: T.text, display: "flex" }}>
      <aside style={{ width: "236px", flexShrink: 0, background: T.surface, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div style={{ padding: "22px 18px 18px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "9px", fontWeight: 700, fontSize: "17px" }}>
            <Building2 size={18} color={T.accent} /> Kairos Property
          </div>
          <div style={{ color: T.muted, fontSize: "11px", marginTop: "6px" }}>Personal property decision workspace</div>
        </div>
        <nav style={{ padding: "14px 10px", flex: 1 }}>
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === "/property" ? pathname === href : pathname.startsWith(href);
            return <Link key={href} href={href} style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "3px", padding: "9px 10px", borderRadius: "7px", background: active ? `${T.accent}18` : "transparent", borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent", textDecoration: "none", color: active ? T.accent : T.textSub, fontSize: "13px", fontWeight: active ? 650 : 450 }}><Icon size={15} />{label}</Link>;
          })}
        </nav>
        <div style={{ padding: "14px", borderTop: `1px solid ${T.border}` }}>
          <Link href="/dashboard" style={{ display: "flex", alignItems: "center", gap: "8px", color: T.textSub, textDecoration: "none", fontSize: "12px" }}><ArrowLeftRight size={14} />Switch to Investing</Link>
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header style={{ minHeight: "58px", padding: "10px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: T.textSub }}>
            <span style={{ color: T.muted }}>Kairos</span><span>/</span><strong style={{ color: T.accent }}>Property</strong>
          </div>
          <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: "6px", overflow: "hidden" }}>
            <Link href="/dashboard" style={{ padding: "6px 10px", color: T.textSub, textDecoration: "none", fontSize: "11px" }}>Investing</Link>
            <span style={{ padding: "6px 10px", background: `${T.accent}1C`, color: T.accent, fontWeight: 700, fontSize: "11px" }}>Property</span>
          </div>
        </header>
        <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      </div>
    </div>
  );
}
