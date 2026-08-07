import Link from "next/link";
import { ArrowRight, Building2, Database, MapPin, ShieldCheck } from "lucide-react";
import { PROPERTY_MARKETS, PROPERTY_SOURCES } from "@/lib/property/registry";

const T = { surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", blue: "#60A5FA", amber: "#FBBF24" };

export default function PropertyOverview() {
  return <div style={{ padding: "28px", maxWidth: "1500px" }}>
    <section style={{ paddingBottom: "24px", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ fontSize: "12px", color: T.accent, fontWeight: 700, letterSpacing: "0.08em" }}>PROPERTY WORKSPACE</div>
      <h1 style={{ margin: "7px 0", fontSize: "25px", letterSpacing: 0, lineHeight: 1.2 }}>Market evidence before property decisions</h1>
      <p style={{ margin: 0, maxWidth: "680px", color: T.textSub, fontSize: "13px", lineHeight: 1.6 }}>Austin, Phoenix, and Bengaluru are tracked as independent markets. P0 establishes the source boundary and health surface before collection, forecasts, or private property records exist.</p>
    </section>
    <section className="property-three-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderBottom: `1px solid ${T.border}` }}>
      {[
        ["Markets", String(PROPERTY_MARKETS.length), "Independent location packs", MapPin, T.accent],
        ["Approved source contracts", String(PROPERTY_SOURCES.length), "Awaiting adapter and terms review", Database, T.blue],
        ["Private records", "0", "Not enabled in this phase", ShieldCheck, T.amber],
      ].map(([label, value, detail, Icon, color]) => { const I = Icon as typeof Building2; return <div key={label as string} style={{ padding: "20px", borderRight: `1px solid ${T.border}` }}><I size={16} color={color as string} /><div style={{ color: T.muted, fontSize: "11px", marginTop: "14px" }}>{label as string}</div><div style={{ fontSize: "25px", fontWeight: 700, marginTop: "4px" }}>{value as string}</div><div style={{ color: T.textSub, fontSize: "11px", marginTop: "4px" }}>{detail as string}</div></div>; })}
    </section>
    <section style={{ paddingTop: "26px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}><div><h2 style={{ margin: 0, fontSize: "16px" }}>Initial market packs</h2><div style={{ color: T.muted, fontSize: "11px", marginTop: "4px" }}>No market data is blended across these locations.</div></div><Link href="/property/markets" style={{ color: T.accent, textDecoration: "none", fontSize: "12px", display: "flex", gap: "5px", alignItems: "center" }}>Explore markets <ArrowRight size={13} /></Link></div>
      <div className="property-three-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" }}>
        {PROPERTY_MARKETS.map((market) => <Link href={`/property/markets?market=${market.id}`} key={market.id} style={{ textDecoration: "none", color: T.text, background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "16px" }}><div style={{ display: "flex", justifyContent: "space-between" }}><strong style={{ fontSize: "14px" }}>{market.label}</strong><span style={{ fontSize: "10px", color: T.accent }}>{market.currency}</span></div><div style={{ fontSize: "11px", color: T.textSub, marginTop: "5px" }}>{market.region}</div><div style={{ fontSize: "11px", color: T.muted, marginTop: "14px", lineHeight: 1.45 }}>{market.scope}</div><div style={{ fontSize: "10px", color: T.muted, marginTop: "12px" }}>{market.localUnit}</div></Link>)}
      </div>
    </section>
    <section style={{ marginTop: "26px", paddingTop: "20px", borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: "10px", color: T.textSub, fontSize: "12px" }}><Building2 size={15} color={T.accent} />Property remains isolated from securities research, brokers, paper portfolios, and execution.</section>
  </div>;
}
