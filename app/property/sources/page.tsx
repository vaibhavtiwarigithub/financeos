import { ExternalLink } from "lucide-react";
import { PROPERTY_SOURCES } from "@/lib/property/registry";

const T = { card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8", muted: "#6B7280", accent: "#34D399", amber: "#FBBF24" };

export default function PropertySourcesPage() {
  return (
    <div className="property-sources-page" style={{ padding: "28px", maxWidth: "1500px" }}>
      <div style={{ color: T.accent, fontWeight: 700, fontSize: "12px", letterSpacing: "0.08em" }}>DATA SOURCES</div>
      <h1 style={{ margin: "7px 0", fontSize: "24px", letterSpacing: 0 }}>Source catalogue and collection health</h1>
      <p style={{ color: T.textSub, fontSize: "13px", lineHeight: 1.55, margin: "0 0 20px", maxWidth: "760px" }}>Official market observations collect on bounded schedules. Parcel evidence collects only for owner-selected Phoenix ZIPs or Austin parcel references; unsupported markets remain explicitly unavailable.</p>
      <div style={{ border: `1px solid ${T.border}`, borderRadius: "7px", overflow: "hidden" }}>
        <div className="property-source-header" style={{ display: "grid", gridTemplateColumns: "1.2fr .9fr 1.3fr .8fr auto", gap: "12px", padding: "10px 14px", color: T.muted, fontSize: "10px", fontWeight: 700, letterSpacing: "0.07em", borderBottom: `1px solid ${T.border}` }}><span>SOURCE</span><span>MARKETS</span><span>USE</span><span>CADENCE</span><span>STATE</span></div>
        {PROPERTY_SOURCES.map((source) => (
          <div className="property-source-card" key={source.id} style={{ display: "grid", gridTemplateColumns: "1.2fr .9fr 1.3fr .8fr auto", gap: "12px", alignItems: "center", padding: "14px", borderBottom: `1px solid ${T.border}`, background: T.card }}>
            <a data-label="SOURCE" href={source.officialUrl} target="_blank" rel="noreferrer" style={{ color: T.text, textDecoration: "none", fontSize: "12px", fontWeight: 650, display: "flex", gap: "5px", alignItems: "center" }}>{source.name}<ExternalLink size={12} color={T.muted} /></a>
            <span data-label="MARKETS" style={{ color: T.textSub, fontSize: "11px" }}>{source.markets.join(", ")}</span>
            <span data-label="USE" style={{ color: T.textSub, fontSize: "11px" }}>{source.role}</span>
            <span data-label="CADENCE" style={{ color: T.textSub, fontSize: "11px" }}>{source.cadence}</span>
            <span data-label="STATE" style={{ color: source.state === "active" ? T.accent : T.amber, fontSize: "10px", fontWeight: 700 }}>{source.state.replaceAll("_", " ").toUpperCase()}</span>
          </div>
        ))}
      </div>
      <style>{`
        @media (max-width: 720px) {
          .property-sources-page { padding: 18px 16px !important; overflow-x: hidden; }
          .property-source-header { display: none !important; }
          .property-source-card { grid-template-columns: minmax(0, 1fr) !important; gap: 8px !important; padding: 14px !important; }
          .property-source-card > [data-label] { display: grid !important; grid-template-columns: minmax(78px, .35fr) minmax(0, 1fr); gap: 10px; align-items: baseline; min-width: 0; overflow-wrap: anywhere; }
          .property-source-card > [data-label]::before { content: attr(data-label); color: ${T.muted}; font-size: 9px; font-weight: 800; }
        }
      `}</style>
    </div>
  );
}
