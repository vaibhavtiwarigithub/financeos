"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Database, LayoutDashboard, Map, ArrowLeftRight, Home, Search, Landmark, ChartNoAxesCombined, Scale, Menu, X } from "lucide-react";

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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  useEffect(() => setMobileNavOpen(false), [pathname]);
  return (
    <div className="property-app-shell" style={{ minHeight: "100dvh", background: T.bg, color: T.text, display: "flex" }}>
      {mobileNavOpen ? <button className="property-nav-backdrop" type="button" aria-label="Close Property navigation" onClick={() => setMobileNavOpen(false)} style={{ display: "none" }} /> : null}
      <aside className={`property-sidebar${mobileNavOpen ? " property-sidebar-open" : ""}`} style={{ width: "236px", flexShrink: 0, background: T.surface, borderRight: `1px solid ${T.border}`, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        <div className="property-brand" style={{ padding: "22px 18px 18px", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "9px", fontWeight: 700, fontSize: "17px" }}><Building2 size={18} color={T.accent} /> Kairos Property</div>
            <button className="property-drawer-close" type="button" aria-label="Close Property navigation" onClick={() => setMobileNavOpen(false)} style={{ display: "none", width: "32px", height: "32px", alignItems: "center", justifyContent: "center", border: `1px solid ${T.border}`, borderRadius: "7px", background: T.card, color: T.text, cursor: "pointer" }}><X size={16} /></button>
          </div>
          <div className="property-brand-subtitle" style={{ color: T.muted, fontSize: "11px", marginTop: "6px" }}>Personal property decision workspace</div>
        </div>
        <div className="property-workspace-switch" style={{ padding: "10px 10px 2px" }}>
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
          <button className="property-mobile-menu" type="button" aria-label="Open navigation menu" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)} style={{ display: "none", width: "32px", height: "32px", alignItems: "center", justifyContent: "center", border: `1px solid ${T.border}`, borderRadius: "7px", background: "transparent", color: T.text, cursor: "pointer", flexShrink: 0 }}><Menu size={16} /></button>
          <div className="property-desktop-context" style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: T.textSub }}>
            <span style={{ color: T.muted }}>Kairos</span><span>/</span><strong style={{ color: T.accent }}>Property</strong>
          </div>
          <strong className="property-mobile-title" style={{ display: "none", color: T.text, fontSize: "13px" }}>Property</strong>
          <div style={{ flex: 1 }} />
          <Link className="property-mobile-investing" href="/dashboard" style={{ display: "none", alignItems: "center", gap: "6px", minHeight: "32px", padding: "6px 9px", border: `1px solid ${T.border}`, borderRadius: "7px", color: T.textSub, textDecoration: "none", fontSize: "11px" }}><ArrowLeftRight size={13} />Investing</Link>
        </header>
        <main className="property-main" style={{ flex: 1, minWidth: 0 }}>{children}</main>
      </div>
      <style>{`
        @media (max-width: 900px) {
          .property-sidebar { width: min(280px, 88vw) !important; min-height: 0 !important; height: 100dvh !important; position: fixed !important; inset: 0 auto 0 0; z-index: 200; transform: translateX(-100%); transition: transform .2s ease; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); box-shadow: 12px 0 30px #00000066; }
          .property-sidebar.property-sidebar-open { transform: translateX(0); }
          .property-nav-backdrop { display: block !important; position: fixed; inset: 0; z-index: 199; border: 0; background: #000000AA; }
          .property-brand { padding: 14px 16px 12px !important; }
          .property-brand-subtitle { display: none !important; }
          .property-drawer-close { display: inline-flex !important; }
          .property-workspace-switch { display: block !important; }
          .property-nav { display: block !important; padding: 12px 10px !important; overflow-y: auto; }
          .property-nav-item { min-width: 0 !important; white-space: normal !important; min-height: 42px !important; }
          .property-sidebar-footer { padding-bottom: calc(14px + env(safe-area-inset-bottom)) !important; }
          .property-context-header { display: flex !important; position: sticky; top: 0; z-index: 100; min-height: 0 !important; padding: calc(7px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right)) 7px calc(12px + env(safe-area-inset-left)) !important; gap: 10px; }
          .property-mobile-menu, .property-mobile-investing { display: inline-flex !important; }
          .property-mobile-title { display: inline !important; }
          .property-desktop-context { display: none !important; }
          .property-main { padding-bottom: env(safe-area-inset-bottom) !important; }
        }
        @media (max-width: 520px) {
          .property-brand > div:first-child { font-size: 15px !important; }
          .property-nav-item { padding: 8px !important; font-size: 11px !important; overflow-wrap: anywhere; }
        }
      `}</style>
    </div>
  );
}
