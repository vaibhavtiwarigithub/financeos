"use client";

import { useMemo, useState } from "react";
import { BookOpenCheck, ChartNoAxesCombined, ShieldCheck } from "lucide-react";
import { Area, CartesianGrid, Line, ComposedChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";

type Market = "Austin" | "Phoenix" | "Bengaluru";

export default function ForecastLearningWorkspace() {
  const [market, setMarket] = useState<Market>("Austin");
  const [baseline, setBaseline] = useState("100");
  const [growth, setGrowth] = useState("");
  const [uncertainty, setUncertainty] = useState("3");
  const [years, setYears] = useState("5");

  const scenario = useMemo(() => {
    const start = Number(baseline);
    const rate = Number(growth);
    const spread = Math.max(0, Number(uncertainty) || 0);
    const count = Math.min(15, Math.max(1, Math.round(Number(years) || 1)));
    if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(rate) || growth.trim() === "") return [];
    return Array.from({ length: count + 1 }, (_, year) => ({
      year,
      base: Number((start * (1 + rate / 100) ** year).toFixed(2)),
      lower: Number((start * (1 + (rate - spread) / 100) ** year).toFixed(2)),
      upper: Number((start * (1 + (rate + spread) / 100) ** year).toFixed(2)),
    }));
  }, [baseline, growth, uncertainty, years]);

  return (
    <PropertyPageFrame eyebrow="Shadow workspace" title="Forecasts & learning" description="Separate user-authored scenarios from future evidence-qualified forecasts, then score predictions only after actual observations arrive.">
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="QUALIFIED FORECASTS" value="0" />
        <StatCell label="SEALED OUTCOMES" value="0" />
        <StatCell label="CALIBRATION" value="Not started" tone={PT.amber} />
        <StatCell label="ADVISORY STATUS" value="Disabled" detail="Requires market-local evidence" />
      </div>
      <div className="property-page-body" style={{ padding: "22px 28px", display: "grid", gap: "18px" }}>
        <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "minmax(280px, 350px) minmax(0, 1fr)", gap: "18px", alignItems: "stretch" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", padding: "16px", background: PT.surface }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}><ChartNoAxesCombined size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Assumption fan</h2></div>
            <div style={{ display: "grid", gap: "12px" }}>
              <FieldLabel label="Market"><select value={market} onChange={(event) => setMarket(event.target.value as Market)} style={fieldStyle}><option>Austin</option><option>Phoenix</option><option>Bengaluru</option></select></FieldLabel>
              <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <FieldLabel label="Starting index"><input inputMode="decimal" value={baseline} onChange={(event) => setBaseline(event.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Years"><input inputMode="numeric" value={years} onChange={(event) => setYears(event.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Annual change %"><input inputMode="decimal" value={growth} onChange={(event) => setGrowth(event.target.value)} placeholder="Enter assumption" style={fieldStyle} /></FieldLabel>
                <FieldLabel label="Range +/- %"><input inputMode="decimal" value={uncertainty} onChange={(event) => setUncertainty(event.target.value)} style={fieldStyle} /></FieldLabel>
              </div>
              <LocalOnlyNotice>This is compound-interest scenario math, not a Kairos prediction. It uses no market data and is never written to the forecast ledger.</LocalOnlyNotice>
            </div>
          </section>
          <section style={{ minWidth: 0, border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface, display: "flex", justifyContent: "space-between", gap: "12px" }}><div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{market} user scenario</h2><div style={{ color: PT.muted, fontSize: "9px", marginTop: "3px" }}>Index basis; not a currency valuation</div></div><span style={{ color: PT.blue, fontSize: "9px", fontWeight: 800 }}>USER ASSUMPTION</span></div>
            <div style={{ height: "330px", padding: "16px 10px 8px" }}>
              {scenario.length === 0 ? <EmptyState title="Enter an annual-change assumption" detail="The chart remains blank until you supply a scenario. Kairos will not invent a market forecast to fill this space." /> : <ResponsiveContainer width="100%" height="100%"><ComposedChart data={scenario} margin={{ top: 8, right: 15, left: 0, bottom: 8 }}><defs><linearGradient id="propertyScenarioBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PT.blue} stopOpacity={0.18} /><stop offset="100%" stopColor={PT.blue} stopOpacity={0.02} /></linearGradient></defs><CartesianGrid stroke={PT.border} vertical={false} /><XAxis dataKey="year" tick={{ fill: PT.muted, fontSize: 10 }} label={{ value: "Year", position: "insideBottom", offset: -2, fill: PT.muted, fontSize: 10 }} /><YAxis tick={{ fill: PT.muted, fontSize: 10 }} domain={["auto", "auto"]} /><Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} /><Area type="monotone" dataKey="upper" stroke="transparent" fill="url(#propertyScenarioBand)" name="Upper path" /><Line type="monotone" dataKey="upper" stroke={PT.blue} strokeDasharray="4 4" dot={false} name="Upper path" /><Line type="monotone" dataKey="base" stroke={PT.accent} strokeWidth={2} dot={false} name="Base path" /><Line type="monotone" dataKey="lower" stroke={PT.blue} strokeDasharray="4 4" dot={false} name="Lower path" /></ComposedChart></ResponsiveContainer>}
            </div>
          </section>
        </div>
        <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.5fr) minmax(250px, .7fr)", gap: "18px" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><BookOpenCheck size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Forecast evidence ledger</h2></div>
            <EmptyState title="No qualified forecasts" detail="A future record must pin its source snapshot, geography, horizon, model version, baseline, uncertainty and later observed outcome. User scenarios above do not qualify." />
          </section>
          <aside style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", padding: "16px", background: PT.surface }}>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}><ShieldCheck size={15} color={PT.blue} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Promotion gates</h2></div>
            <div style={{ display: "grid", gap: "11px", marginTop: "15px" }}>
              {["Revision-aware observations", "Market-local baseline", "Sealed replay window", "Forward calibration", "Error and coverage floors"].map((gate) => <div key={gate} style={{ display: "flex", justifyContent: "space-between", gap: "10px", paddingBottom: "10px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}><span>{gate}</span><strong style={{ color: PT.amber, fontSize: "9px" }}>PENDING</strong></div>)}
            </div>
          </aside>
        </div>
      </div>
    </PropertyPageFrame>
  );
}
