"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Building2, Database, MapPin, ShieldCheck } from "lucide-react";
import { PROPERTY_MARKETS, PROPERTY_SOURCES } from "@/lib/property/registry";

const T = { surface: "#13151C", card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", blue: "#60A5FA", amber: "#FBBF24" };

type WorkspaceSummary = {
  privateRecords: { activeCount: number; storageStatus: "ready" | "locked"; byMarket: Array<{ market: string; count: number }> };
  activeSources: Array<{ sourceKey: string; displayName: string; cadence: string }>;
};

export default function PropertyOverview() {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/property/overview?market=austin", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Overview unavailable");
        return response.json() as Promise<{ workspace: WorkspaceSummary }>;
      })
      .then((payload) => { if (!cancelled) setWorkspace(payload.workspace); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  const activeSourceCount = workspace?.activeSources.length ?? PROPERTY_SOURCES.filter((source) => source.state === "active").length;
  const assetCount = workspace?.privateRecords.activeCount;
  const assetDetail = loadFailed
    ? "Status temporarily unavailable"
    : workspace
      ? workspace.privateRecords.storageStatus === "ready"
        ? "Active owner records; private details remain sealed"
        : "Private storage is locked"
      : "Loading owner record status";
  return <div className="property-overview" style={{ padding: "28px", maxWidth: "1500px" }}>
    <section style={{ paddingBottom: "24px", borderBottom: `1px solid ${T.border}` }}>
      <div style={{ fontSize: "12px", color: T.accent, fontWeight: 700, letterSpacing: "0.08em" }}>PROPERTY WORKSPACE</div>
      <h1 style={{ margin: "7px 0", fontSize: "25px", letterSpacing: 0, lineHeight: 1.2 }}>Market evidence before property decisions</h1>
      <p style={{ margin: 0, maxWidth: "680px", color: T.textSub, fontSize: "13px", lineHeight: 1.6 }}>Austin, Phoenix, and Bengaluru are tracked as independent markets. Market evidence, owner records, and source status stay separate from securities research and execution.</p>
    </section>
    <section className="property-three-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderBottom: `1px solid ${T.border}` }}>
      {[
        ["Markets", String(PROPERTY_MARKETS.length), "Independent location packs", MapPin, T.accent],
        ["Active sources", String(activeSourceCount), workspace ? "Approved for collection" : "Loading source status", Database, T.blue],
        ["Active private records", assetCount == null ? "—" : String(assetCount), assetDetail, ShieldCheck, workspace?.privateRecords.storageStatus === "ready" ? T.amber : T.muted],
      ].map(([label, value, detail, Icon, color]) => { const I = Icon as typeof Building2; return <div key={label as string} style={{ padding: "20px", borderRight: `1px solid ${T.border}` }}><I size={16} color={color as string} /><div style={{ color: T.muted, fontSize: "11px", marginTop: "14px" }}>{label as string}</div><div style={{ fontSize: "25px", fontWeight: 700, marginTop: "4px" }}>{value as string}</div><div style={{ color: T.textSub, fontSize: "11px", marginTop: "4px" }}>{detail as string}</div></div>; })}
    </section>
    <section style={{ paddingTop: "26px" }}>
      <div className="property-overview-heading" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", gap: "12px" }}><div><h2 style={{ margin: 0, fontSize: "16px" }}>Initial market packs</h2><div style={{ color: T.muted, fontSize: "11px", marginTop: "4px" }}>No market data is blended across these locations.</div></div><Link href="/property/markets" style={{ color: T.accent, textDecoration: "none", fontSize: "12px", display: "flex", gap: "5px", alignItems: "center", flexShrink: 0 }}>Explore markets <ArrowRight size={13} /></Link></div>
      <div className="property-three-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" }}>
        {PROPERTY_MARKETS.map((market) => <Link href={`/property/markets?market=${market.id}`} key={market.id} style={{ textDecoration: "none", color: T.text, background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "16px" }}><div style={{ display: "flex", justifyContent: "space-between" }}><strong style={{ fontSize: "14px" }}>{market.label}</strong><span style={{ fontSize: "10px", color: T.accent }}>{market.currency}</span></div><div style={{ fontSize: "11px", color: T.textSub, marginTop: "5px" }}>{market.region}</div><div style={{ fontSize: "11px", color: T.muted, marginTop: "14px", lineHeight: 1.45 }}>{market.scope}</div><div style={{ fontSize: "10px", color: T.muted, marginTop: "12px" }}>{market.localUnit}</div></Link>)}
      </div>
    </section>
    {workspace?.privateRecords.byMarket.some((item) => item.count > 0) ? <section style={{ marginTop: "26px", paddingTop: "20px", borderTop: `1px solid ${T.border}` }}>
      <div style={{ fontSize: "12px", color: T.textSub, fontWeight: 700, marginBottom: "10px" }}>Active owner records by market</div>
      <div className="property-three-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "10px" }}>
        {PROPERTY_MARKETS.map((market) => {
          const count = workspace.privateRecords.byMarket.find((item) => item.market === market.id)?.count ?? 0;
          return <Link key={market.id} href="/property/properties" style={{ textDecoration: "none", color: T.text, background: T.card, border: `1px solid ${T.border}`, borderRadius: "8px", padding: "13px" }}><div style={{ fontSize: "12px", fontWeight: 700 }}>{market.label}</div><div style={{ color: T.textSub, fontSize: "11px", marginTop: "5px" }}>{count} active {count === 1 ? "record" : "records"}</div></Link>;
        })}
      </div>
    </section> : null}
    <section style={{ marginTop: "26px", paddingTop: "20px", borderTop: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: "10px", color: T.textSub, fontSize: "12px" }}><Building2 size={15} color={T.accent} style={{ flexShrink: 0 }} />Property remains isolated from securities research, brokers, paper portfolios, and execution.</section>
    <style>{`
      @media (max-width: 720px) {
        .property-overview { padding: 18px 16px !important; overflow-x: hidden; }
        .property-three-grid { grid-template-columns: minmax(0, 1fr) !important; }
        .property-three-grid > * { border-right: 0 !important; border-bottom: 1px solid ${T.border}; }
        .property-overview-heading { align-items: flex-start !important; flex-direction: column !important; }
      }
    `}</style>
  </div>;
}
