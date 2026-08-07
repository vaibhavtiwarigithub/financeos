"use client";

import { useMemo, useState } from "react";
import { BarChart3, Calculator, Plus, Trash2 } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";

type Deal = {
  id: number;
  name: string;
  market: "Austin" | "Phoenix" | "Bengaluru";
  price: number;
  rent: number;
  annualCosts: number;
  downPct: number;
  rate: number;
};

function monthlyPayment(principal: number, annualRate: number, years = 30) {
  if (principal <= 0) return 0;
  const rate = annualRate / 1200;
  const months = years * 12;
  if (rate === 0) return principal / months;
  return principal * (rate * (1 + rate) ** months) / ((1 + rate) ** months - 1);
}

function metrics(deal: Deal) {
  const noi = deal.rent * 12 - deal.annualCosts;
  const loan = deal.price * (1 - deal.downPct / 100);
  const debtService = monthlyPayment(loan, deal.rate) * 12;
  const cashInvested = deal.price * deal.downPct / 100;
  return {
    noi,
    capRate: deal.price > 0 ? noi / deal.price * 100 : 0,
    annualCashFlow: noi - debtService,
    cashOnCash: cashInvested > 0 ? (noi - debtService) / cashInvested * 100 : 0,
  };
}

export default function OpportunitiesWorkspace() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [name, setName] = useState("");
  const [market, setMarket] = useState<Deal["market"]>("Austin");
  const [price, setPrice] = useState("");
  const [rent, setRent] = useState("");
  const [annualCosts, setAnnualCosts] = useState("");
  const [downPct, setDownPct] = useState("20");
  const [rate, setRate] = useState("");

  const chartData = useMemo(() => deals.map((deal) => ({ name: deal.name, cashFlow: Math.round(metrics(deal).annualCashFlow), capRate: Number(metrics(deal).capRate.toFixed(2)) })), [deals]);

  function addDeal() {
    const parsedPrice = Number(price);
    if (!name.trim() || !Number.isFinite(parsedPrice) || parsedPrice <= 0) return;
    setDeals((current) => [...current, { id: Date.now(), name: name.trim(), market, price: parsedPrice, rent: Number(rent) || 0, annualCosts: Number(annualCosts) || 0, downPct: Number(downPct) || 0, rate: Number(rate) || 0 }]);
    setName(""); setPrice(""); setRent(""); setAnnualCosts("");
  }

  const validForComparison = new Set(deals.map((deal) => deal.market === "Bengaluru" ? "INR" : "USD")).size <= 1;

  return (
    <PropertyPageFrame eyebrow="Decision lab" title="Opportunities" description="Compare user-entered deal assumptions with deterministic rental math. This page does not discover listings or estimate market prices.">
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="SCENARIOS" value={String(deals.length)} />
        <StatCell label="LIVE LISTINGS" value="Not connected" tone={PT.amber} />
        <StatCell label="VALUATION MODEL" value="Not enabled" />
        <StatCell label="CURRENCY CONTROL" value={validForComparison ? "Comparable" : "Market split"} tone={validForComparison ? PT.accent : PT.amber} detail="USD and INR never combine" />
      </div>
      <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(290px, 370px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
        <section style={{ border: `1px solid ${PT.border}`, background: PT.surface, borderRadius: "7px", padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}><Calculator size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Add deal assumptions</h2></div>
          <div style={{ display: "grid", gap: "11px" }}>
            <FieldLabel label="Scenario name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: North Austin duplex" style={fieldStyle} /></FieldLabel>
            <FieldLabel label="Market"><select value={market} onChange={(event) => setMarket(event.target.value as Deal["market"])} style={fieldStyle}><option>Austin</option><option>Phoenix</option><option>Bengaluru</option></select></FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label="Purchase price"><input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Required" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Monthly rent"><input inputMode="decimal" value={rent} onChange={(event) => setRent(event.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Annual operating costs" hint="Tax, insurance, maintenance and vacancy; exclude debt service."><input inputMode="decimal" value={annualCosts} onChange={(event) => setAnnualCosts(event.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Down payment %"><input inputMode="decimal" value={downPct} onChange={(event) => setDownPct(event.target.value)} style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Loan rate %"><input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
            </div>
            <button type="button" onClick={addDeal} disabled={!name.trim() || Number(price) <= 0} style={{ ...buttonStyle, display: "flex", justifyContent: "center", alignItems: "center", gap: "6px", opacity: name.trim() && Number(price) > 0 ? 1 : 0.45 }}><Plus size={14} />Add comparison</button>
            <LocalOnlyNotice>Results use your assumptions and a 30-year amortization. They exclude closing costs, taxes on income, appreciation, and market-specific legal constraints.</LocalOnlyNotice>
          </div>
        </section>
        <div style={{ minWidth: 0, display: "grid", gap: "18px" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", display: "flex", gap: "8px", alignItems: "center", background: PT.surface, borderBottom: `1px solid ${PT.border}` }}><BarChart3 size={15} color={PT.blue} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Deal comparison</h2></div>
            {deals.length === 0 ? <EmptyState title="No opportunities to compare" detail="Enter a candidate using figures you already have. Sourced listing discovery will remain absent until a permitted provider is connected." /> : (
              <div style={{ padding: "16px", height: "260px" }}>
                {validForComparison ? <ResponsiveContainer width="100%" height="100%"><BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 12 }}><CartesianGrid stroke={PT.border} vertical={false} /><XAxis dataKey="name" tick={{ fill: PT.muted, fontSize: 10 }} /><YAxis tick={{ fill: PT.muted, fontSize: 10 }} /><Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} /><Bar dataKey="cashFlow" name="Annual cash flow" fill={PT.accent} radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer> : <EmptyState title="Comparison split by currency" detail="USD and INR cash flows cannot share one scale. Remove one market group to compare the remaining scenarios." />}
              </div>
            )}
          </section>
          {deals.length ? <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1.2fr .7fr .8fr .8fr .9fr 28px", gap: "8px", padding: "9px 12px", color: PT.muted, fontSize: "9px", fontWeight: 800, borderBottom: `1px solid ${PT.border}` }}><span>SCENARIO</span><span>MARKET</span><span>CAP RATE</span><span>CASH/CASH</span><span>ANNUAL CASH FLOW</span><span /></div>
            {deals.map((deal) => { const result = metrics(deal); const code = deal.market === "Bengaluru" ? "INR" : "USD"; return <div className="property-table-row" key={deal.id} style={{ display: "grid", gridTemplateColumns: "1.2fr .7fr .8fr .8fr .9fr 28px", gap: "8px", alignItems: "center", padding: "12px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}><strong style={{ color: PT.text }}>{deal.name}</strong><span>{deal.market}</span><span>{result.capRate.toFixed(2)}%</span><span>{result.cashOnCash.toFixed(2)}%</span><span style={{ color: result.annualCashFlow >= 0 ? PT.accent : PT.red }}>{code} {Math.round(result.annualCashFlow).toLocaleString()}</span><button type="button" title="Remove scenario" aria-label={`Remove ${deal.name}`} onClick={() => setDeals((current) => current.filter((entry) => entry.id !== deal.id))} style={{ border: 0, background: "transparent", color: PT.muted, cursor: "pointer", padding: "4px" }}><Trash2 size={14} /></button></div>; })}
          </section> : null}
        </div>
      </div>
    </PropertyPageFrame>
  );
}
