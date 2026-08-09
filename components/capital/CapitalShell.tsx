"use client";

import Link from "next/link";
import { Building2, Landmark, LineChart } from "lucide-react";

const T = { bg: "#0D0F14", surface: "#13151C", border: "#2A2E3C", text: "#ECEDEF", textSub: "#A6AAB5", muted: "#737986", accent: "#FBBF24" };

export default function CapitalShell({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: "100dvh", background: T.bg, color: T.text }}>
    <header style={{ minHeight: "58px", padding: "10px clamp(16px, 3vw, 30px)", display: "flex", alignItems: "center", gap: "14px", borderBottom: `1px solid ${T.border}`, background: T.surface, flexWrap: "wrap" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", fontWeight: 750, fontSize: "15px" }}><Landmark size={17} color={T.accent} />Kairos Capital Plan</div>
      <div style={{ flex: 1 }} />
      <nav aria-label="Workspace switcher" style={{ display: "flex", border: `1px solid ${T.border}`, borderRadius: "7px", overflow: "hidden" }}>
        <Link href="/dashboard" style={{ padding: "7px 10px", color: T.textSub, textDecoration: "none", fontSize: "11px", borderRight: `1px solid ${T.border}`, display: "inline-flex", alignItems: "center", gap: "5px" }}><LineChart size={13} />Investing</Link>
        <Link href="/property" style={{ padding: "7px 10px", color: T.textSub, textDecoration: "none", fontSize: "11px", borderRight: `1px solid ${T.border}`, display: "inline-flex", alignItems: "center", gap: "5px" }}><Building2 size={13} />Property</Link>
        <span style={{ padding: "7px 10px", background: `${T.accent}18`, color: T.accent, fontSize: "11px", fontWeight: 750 }}>Capital Plan</span>
      </nav>
    </header>
    {children}
  </div>;
}
