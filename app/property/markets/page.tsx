import Link from "next/link";
import { marketById, PROPERTY_MARKETS, sourcesForMarket } from "@/lib/property/registry";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", amber: "#FBBF24" };

export default async function PropertyMarketsPage({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  const market = marketById((await searchParams).market);
  const sources = sourcesForMarket(market.id);
  return <div style={{ padding: "28px", maxWidth: "1500px" }}>
    <div style={{ fontSize: "12px", color: T.accent, fontWeight: 700, letterSpacing: "0.08em" }}>MARKET EXPLORER</div><h1 style={{ margin: "7px 0 20px", fontSize: "24px" }}>{market.label} market pack</h1>
    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "20px" }}>{PROPERTY_MARKETS.map((item) => <Link key={item.id} href={`/property/markets?market=${item.id}`} style={{ padding: "7px 10px", border: `1px solid ${item.id === market.id ? T.accent : T.border}`, borderRadius: "6px", textDecoration: "none", color: item.id === market.id ? T.accent : T.textSub, fontSize: "12px" }}>{item.label}</Link>)}</div>
    <div className="property-main-grid" style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "14px" }}>
      <section style={{ border: `1px solid ${T.border}`, background: T.card, borderRadius: "8px", padding: "18px" }}><h2 style={{ fontSize: "15px", margin: 0 }}>Evidence readiness</h2><p style={{ fontSize: "12px", color: T.textSub, lineHeight: 1.55 }}>No observations have been collected yet. A source cannot be activated until its metric definition, permitted use, geography, cadence, revision behavior, and failure mode are recorded.</p><div style={{ borderTop: `1px solid ${T.border}` }}>{sources.map((source) => <div key={source.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr auto", gap: "12px", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${T.border}` }}><div><div style={{ fontSize: "12px", fontWeight: 650 }}>{source.name}</div><div style={{ fontSize: "10px", color: T.muted, marginTop: "3px" }}>{source.coverage}</div></div><div style={{ fontSize: "11px", color: T.textSub }}>{source.role}<br /><span style={{ color: T.muted }}>{source.cadence}</span></div><span style={{ color: T.amber, fontSize: "10px", fontWeight: 700 }}>NOT COLLECTING</span></div>)}</div></section>
      <aside style={{ border: `1px solid ${T.border}`, borderRadius: "8px", padding: "18px" }}><div style={{ color: T.muted, fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em" }}>CONTEXT</div><div style={{ fontSize: "15px", marginTop: "9px", fontWeight: 650 }}>{market.country === "US" ? "United States" : "India"} / {market.region}</div><div style={{ marginTop: "18px", color: T.textSub, fontSize: "12px", lineHeight: 1.5 }}>Canonical geographic unit: {market.localUnit}. All future charts must show source, definition, unit, as-of date, and revision state.</div></aside>
    </div>
  </div>;
}
