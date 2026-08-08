"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Database, LayoutDashboard, Map, ArrowLeftRight, Home, Search, Landmark, ChartNoAxesCombined, Scale } from "lucide-react";

const T = {
  bg: "#0D0F14", surface: "#13151C", card: "#1A1D27", border: "#252836",
  text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", blue: "#60A5FA",
};

const nav = [
  { href: "/property", label: "Overview", icon: LayoutDashboard },
  { href: "/property/markets", label: "Market Explorer", icon: Map },
  { href: "/property/valuation", label: "Valuation Evidence", icon: Scale },
  { href: "/property/my-properties", label: "My Properties", icon: Home },
  { href: "/property/opportunities", label: "Opportunities", icon: Search },
  { href: "/property/financing", label: "Financing", icon: Landmark },
  { href: "/property/forecasts", label: "Forecasts & Learning", icon: ChartNoAxesCombined },
  { href: "/property/sources", label: "Data Sources", icon: Database },
];

export default function PropertyShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="property-app-shell" style={{ minHeight: "100vh", background: T.bg, color: T.text, display: "flex" }}>
      <aside className="property-sidebar" style={{ width: "236px", flexShrink: 0, background: T.surface, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div className="property-brand" style={{ padding: "22px 18px 18px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: "9px", fontWeight: 700, fontSize: "17px" }}>
            <Building2 size={18} color={T.accent} /> Kairos Property
          </div>
          <div style={{ color: T.muted, fontSize: "11px", marginTop: "6px" }}>Personal property decision workspace</div>
        </div>
        <div style={{ padding: "10px 10px 2px" }}>
          <div style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <Link href="/dashboard" style={{ flex: 1, padding: "7px 8px", color: T.textSub, textDecoration: "none", fontSize: "11px", textAlign: "center", borderRight: `1px solid ${T.border}` }}>Investing</Link>
            <span style={{ flex: 1, padding: "7px 8px", background: `${T.accent}18`, color: T.accent, fontSize: "11px", fontWeight: 700, textAlign: "center" }}>Property</span>
          </div>
        </div>
        <nav className="property-nav" aria-label="Property workspace" style={{ padding: "14px 10px", flex: 1 }}>
          {nav.map(({ href, label, icon: Icon }) => {
            const active = href === "/property" ? pathname === href : pathname.startsWith(href);
            return <Link className="property-nav-item" key={href} href={href} style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "3px", padding: "9px 10px", borderRadius: "7px", background: active ? `${T.accent}18` : "transparent", borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent", textDecoration: "none", color: active ? T.accent : T.textSub, fontSize: "13px", fontWeight: active ? 650 : 450, whiteSpace: "nowrap" }}><Icon size={15} />{label}</Link>;
          })}
        </nav>
        <div className="property-sidebar-footer" style={{ padding: "14px", borderTop: `1px solid ${T.border}` }}>
          <Link href="/dashboard" style={{ display: "flex", alignItems: "center", gap: "8px", color: T.textSub, textDecoration: "none", fontSize: "12px" }}><ArrowLeftRight size={14} />Switch to Investing</Link>
        </div>
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <header className="property-context-header" style={{ minHeight: "58px", padding: "10px 28px", display: "flex", alignItems: "center", borderBottom: `1px solid ${T.border}`, background: T.surface }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: T.textSub }}>
            <span style={{ color: T.muted }}>Kairos</span><span>/</span><strong style={{ color: T.accent }}>Property</strong>
          </div>
        </header>
        <main style={{ flex: 1, minWidth: 0 }}>{children}</main>
      </div>
      <style>{`
        @media (max-width: 900px) {
          .property-app-shell { flex-direction: column !important; }
          .property-sidebar { width: 100% !important; min-height: auto !important; border-right: 0 !important; border-bottom: 1px solid ${T.border} !important; }
          .property-brand { padding: 14px 16px 12px !important; }
          .property-nav { display: flex !important; gap: 4px !important; overflow-x: auto !important; padding: 9px 10px !important; scrollbar-width: thin; }
          .property-nav-item { margin-bottom: 0 !important; border-left: 0 !important; border-bottom: 2px solid transparent !important; flex: 0 0 auto !important; }
          .property-sidebar-footer { display: none !important; }
          .property-context-header { display: none !important; }
        }
        @media (max-width: 520px) {
          .property-brand > div:first-child { font-size: 15px !important; }
          .property-nav-item { padding: 8px !important; font-size: 11px !important; }
        }
      `}</style>
    </div>
  );
}
