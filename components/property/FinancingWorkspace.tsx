"use client";

import { useMemo, useState } from "react";
import { Calculator, Landmark, RotateCcw } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";

type Mode = "Mortgage" | "Refinance" | "HELOC";

function payment(principal: number, annualRate: number, years: number) {
  if (principal <= 0 || years <= 0) return 0;
  const monthlyRate = annualRate / 1200;
  const months = years * 12;
  if (monthlyRate === 0) return principal / months;
  return principal * monthlyRate * (1 + monthlyRate) ** months / ((1 + monthlyRate) ** months - 1);
}

export default function FinancingWorkspace() {
  const [mode, setMode] = useState<Mode>("Mortgage");
  const [principal, setPrincipal] = useState("400000");
  const [rate, setRate] = useState("6.5");
  const [years, setYears] = useState("30");
  const [fees, setFees] = useState("0");
  const [currentPayment, setCurrentPayment] = useState("");

  const result = useMemo(() => {
    const amount = Math.max(0, Number(principal) || 0);
    const annualRate = Math.max(0, Number(rate) || 0);
    const term = Math.max(1, Number(years) || 1);
    const monthly = mode === "HELOC" ? amount * annualRate / 1200 : payment(amount, annualRate, term);
    const totalPayments = monthly * term * 12;
    const totalInterest = mode === "HELOC" ? monthly * 12 : Math.max(0, totalPayments - amount);
    const savings = mode === "Refinance" && Number(currentPayment) > 0 ? Number(currentPayment) - monthly : 0;
    const breakEven = savings > 0 ? (Number(fees) || 0) / savings : null;
    return { amount, annualRate, term, monthly, totalInterest, savings, breakEven };
  }, [principal, rate, years, fees, currentPayment, mode]);

  const balanceData = useMemo(() => {
    if (mode === "HELOC" || result.amount <= 0) return [];
    const monthlyRate = result.annualRate / 1200;
    const monthly = result.monthly;
    let balance = result.amount;
    const rows = [{ year: 0, balance: Math.round(balance) }];
    for (let month = 1; month <= result.term * 12; month += 1) {
      const interest = balance * monthlyRate;
      balance = Math.max(0, balance - Math.max(0, monthly - interest));
      if (month % 12 === 0) rows.push({ year: month / 12, balance: Math.round(balance) });
    }
    return rows;
  }, [mode, result]);

  return (
    <PropertyPageFrame eyebrow="Scenario calculator" title="Financing" description="Model mortgage, refinance, and HELOC mechanics from your inputs. Rates shown here are never lender quotes or recommendations.">
      <div style={{ padding: "12px 28px", borderBottom: `1px solid ${PT.border}`, display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {(["Mortgage", "Refinance", "HELOC"] as Mode[]).map((item) => <button type="button" key={item} onClick={() => setMode(item)} style={{ minHeight: "32px", padding: "6px 12px", borderRadius: "6px", border: `1px solid ${mode === item ? PT.accent : PT.border}`, background: mode === item ? `${PT.accent}14` : "transparent", color: mode === item ? PT.accent : PT.textSub, fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>{item}</button>)}
      </div>
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label={mode === "HELOC" ? "INTEREST-ONLY / MONTH" : "PRINCIPAL + INTEREST / MONTH"} value={result.monthly.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })} />
        <StatCell label={mode === "HELOC" ? "FIRST-YEAR INTEREST" : "LIFETIME INTEREST"} value={result.totalInterest.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })} />
        <StatCell label="MONTHLY SAVINGS" value={mode === "Refinance" ? result.savings.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 }) : "—"} tone={result.savings > 0 ? PT.accent : PT.text} />
        <StatCell label="FEE BREAK-EVEN" value={mode === "Refinance" && result.breakEven != null ? `${result.breakEven.toFixed(1)} months` : "—"} />
      </div>
      <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>{mode === "Refinance" ? <RotateCcw size={15} color={PT.accent} /> : mode === "HELOC" ? <Landmark size={15} color={PT.accent} /> : <Calculator size={15} color={PT.accent} />}<h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{mode} assumptions</h2></div>
          <div style={{ display: "grid", gap: "12px" }}>
            <FieldLabel label={mode === "HELOC" ? "Expected balance (USD)" : "Loan amount (USD)"}><input inputMode="decimal" value={principal} onChange={(event) => setPrincipal(event.target.value)} style={fieldStyle} /></FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label="Annual rate %"><input inputMode="decimal" value={rate} onChange={(event) => setRate(event.target.value)} style={fieldStyle} /></FieldLabel>
              <FieldLabel label={mode === "HELOC" ? "Projection years" : "Term years"}><input inputMode="numeric" value={years} onChange={(event) => setYears(event.target.value)} style={fieldStyle} /></FieldLabel>
            </div>
            {mode === "Refinance" ? <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><FieldLabel label="Current monthly P&I"><input inputMode="decimal" value={currentPayment} onChange={(event) => setCurrentPayment(event.target.value)} placeholder="Optional" style={fieldStyle} /></FieldLabel><FieldLabel label="Refinance fees"><input inputMode="decimal" value={fees} onChange={(event) => setFees(event.target.value)} style={fieldStyle} /></FieldLabel></div> : null}
            <LocalOnlyNotice>This calculator excludes tax, insurance, PMI, variable-rate changes, prepayment penalties, lender qualification, and India-specific loan terms. Inputs are not saved.</LocalOnlyNotice>
          </div>
        </section>
        <section style={{ minWidth: 0, border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
          <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{mode === "HELOC" ? "Balance behavior" : "Projected principal balance"}</h2><div style={{ color: PT.muted, fontSize: "9px", marginTop: "3px" }}>{mode === "HELOC" ? "No payoff curve is shown for an interest-only revolving balance." : "Deterministic amortization from the assumptions at left."}</div></div>
          <div style={{ height: "330px", padding: "18px 12px 8px" }}>
            {mode === "HELOC" ? <div style={{ height: "100%", display: "grid", placeItems: "center", color: PT.muted, fontSize: "11px", textAlign: "center", padding: "20px" }}>HELOC balances depend on future draws, repayments, and rate changes. A fixed curve would be misleading.</div> : <ResponsiveContainer width="100%" height="100%"><AreaChart data={balanceData} margin={{ top: 8, right: 15, left: 4, bottom: 8 }}><defs><linearGradient id="propertyBalance" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PT.blue} stopOpacity={0.35} /><stop offset="100%" stopColor={PT.blue} stopOpacity={0.02} /></linearGradient></defs><CartesianGrid stroke={PT.border} vertical={false} /><XAxis dataKey="year" tick={{ fill: PT.muted, fontSize: 10 }} label={{ value: "Year", position: "insideBottom", offset: -2, fill: PT.muted, fontSize: 10 }} /><YAxis tick={{ fill: PT.muted, fontSize: 10 }} tickFormatter={(value) => `$${Math.round(value / 1000)}k`} /><Tooltip formatter={(value) => [`$${Number(value).toLocaleString()}`, "Balance"]} contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} /><Area type="monotone" dataKey="balance" stroke={PT.blue} fill="url(#propertyBalance)" strokeWidth={2} /></AreaChart></ResponsiveContainer>}
          </div>
        </section>
      </div>
    </PropertyPageFrame>
  );
}
