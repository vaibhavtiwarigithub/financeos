"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock } from "lucide-react";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { PropertyField } from "./MyPropertiesWorkspace";
import { usePropertyMarket } from "@/lib/property/market-context";
import { summarizeAmortization, type AmortizationSummary } from "@/lib/property/amortization";
import { evaluateRefinance, type RefinanceResult } from "@/lib/property/scenarios";

type PropertyOption = { id: string; name: string; mortgageRatePct?: number; loan?: number };

const money = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 0 });
const today = () => new Date().toISOString().slice(0, 10);
const parsePositive = (raw: string) => { const n = Number(raw); return Number.isFinite(n) && n > 0 ? n : null; };
const parseNonNegative = (raw: string) => { const n = Number(raw); return Number.isFinite(n) && n >= 0 ? n : null; };

export default function AmortizationWorkspace() {
  const { market } = usePropertyMarket();
  const [properties, setProperties] = useState<PropertyOption[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loan, setLoan] = useState<Record<string, string>>({ startDate: "" });
  const [refi, setRefi] = useState<Record<string, string>>({ newTermYears: "30", closingCostsTouched: "" });
  const [fredRate, setFredRate] = useState<{ value: number; asOf: string } | null>(null);
  const [fredError, setFredError] = useState("");

  const loanField = (key: string) => loan[key] ?? "";
  const changeLoan = (key: string, value: string) => setLoan((c) => ({ ...c, [key]: value }));
  const refiField = (key: string) => refi[key] ?? "";
  const changeRefi = (key: string, value: string) => setRefi((c) => ({ ...c, [key]: value }));

  useEffect(() => {
    fetch("/api/property/assets", { cache: "no-store" }).then((r) => r.json()).then((payload) => {
      const options = (payload.assets ?? []).map((row: any): PropertyOption => ({
        id: row.id, name: row.display_label, mortgageRatePct: row.details?.mortgageRatePct, loan: row.details?.loan,
      }));
      setProperties(options);
    }).catch(() => setProperties([]));
  }, []);

  // Today's 30-yr rate context is US-only (FRED MORTGAGE30US, via the same
  // weekly collector that owns lib/property/sources.ts) and isn't fetched a
  // second time here — this reads the observation the existing overview
  // endpoint already returns.
  useEffect(() => {
    setFredRate(null); setFredError("");
    if (market === "bengaluru") return;
    fetch(`/api/property/overview?market=${market}`, { cache: "no-store" }).then((r) => r.json()).then((payload) => {
      const rows = (payload.observations ?? []).filter((o: any) => o.metric_key === "mortgage_rate");
      const latest = rows.reduce((best: any, row: any) => (!best || row.as_of > best.as_of ? row : best), null);
      if (latest) setFredRate({ value: Number(latest.value), asOf: latest.as_of });
      else setFredError("No FRED mortgage-rate observation has been collected yet");
    }).catch(() => setFredError("Today's rate is temporarily unavailable"));
  }, [market]);

  function prefillFrom(id: string) {
    setSelectedId(id);
    const property = properties.find((p) => p.id === id);
    if (property?.mortgageRatePct != null) changeLoan("annualRatePct", String(property.mortgageRatePct));
  }

  const summary: AmortizationSummary | null = useMemo(() => {
    const originalPrincipal = parsePositive(loanField("originalPrincipal"));
    const annualRatePct = parseNonNegative(loanField("annualRatePct"));
    const originalTermMonths = parsePositive(loanField("originalTermYears"));
    const startDate = loanField("startDate");
    if (originalPrincipal == null || annualRatePct == null || originalTermMonths == null || !startDate) return null;
    try {
      return summarizeAmortization({ originalPrincipal, annualRatePct, originalTermMonths: Math.round(originalTermMonths * 12), startDate });
    } catch { return null; }
  }, [loan]);

  // A sensible, visible, editable default — never a hidden constant. Reset
  // only while the field hasn't been hand-edited yet.
  useEffect(() => {
    if (summary && refiField("closingCostsTouched") !== "yes") {
      changeRefi("closingCosts", String(Math.round(summary.currentBalance * 0.02)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.currentBalance]);

  const refinance: RefinanceResult | null = useMemo(() => {
    if (!summary || summary.remainingMonths <= 0) return null;
    const newAnnualRatePct = parseNonNegative(refiField("newAnnualRatePct"));
    const newTermMonths = parsePositive(refiField("newTermYears"));
    const closingCosts = parseNonNegative(refiField("closingCosts"));
    const annualRatePct = parseNonNegative(loanField("annualRatePct"));
    if (newAnnualRatePct == null || newTermMonths == null || closingCosts == null || annualRatePct == null) return null;
    try {
      return evaluateRefinance({
        balance: summary.currentBalance, currentAnnualRatePct: annualRatePct, currentRemainingMonths: summary.remainingMonths,
        newAnnualRatePct, newTermMonths: Math.round(newTermMonths * 12), closingCosts,
      });
    } catch { return null; }
  }, [summary, refi, loan]);

  return <PropertyPageFrame
    eyebrow="Financing"
    title="Amortization & refinance breakeven"
    description="Split a loan's full amortization schedule into what's paid to date and what's left, then check whether refinancing at today's rate is worth its closing cost."
    help={{
      whatItDoes: "Rebuilds the loan's full amortization schedule from its original principal, rate, term, and start date, then compares your current rate against today's FRED 30-yr average to size a refinance's breakeven.",
      whatToLookFor: [
        "Paid-to-date interest is money already spent; it does not come back by refinancing.",
        "Months to break even counts from closing, not from the loan's start.",
        "A negative lifetime saving means refinancing costs more than it saves over the remaining term as entered.",
      ],
    }}
  >
    <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(300px, 380px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
      <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px", display: "grid", gap: "12px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}><CalendarClock size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Loan as originated</h2></div>
        {properties.length ? <FieldLabel label="Prefill rate from a tracked property" hint="Only fills the rate — original principal and start date aren't stored on a property record."><select value={selectedId} onChange={(e) => prefillFrom(e.target.value)} style={fieldStyle}><option value="">Manual entry</option>{properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></FieldLabel> : null}
        <PropertyField name="originalPrincipal" label="Original loan amount" placeholder="e.g. 300000" hint="The principal at closing, not today's balance." numeric value={loanField("originalPrincipal")} onChange={changeLoan} />
        <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
          <PropertyField name="annualRatePct" label="Loan rate %" placeholder="6.5" numeric value={loanField("annualRatePct")} onChange={changeLoan} />
          <PropertyField name="originalTermYears" label="Original term (years)" placeholder="30" numeric value={loanField("originalTermYears")} onChange={changeLoan} />
        </div>
        <PropertyField name="startDate" type="date" label="Loan start date" hint="Used to compute how many payments have elapsed." value={loanField("startDate")} onChange={changeLoan} />
        <LocalOnlyNotice>Computed entirely in your browser from the numbers above — nothing here is saved.</LocalOnlyNotice>
      </section>

      <section style={{ display: "grid", gap: "18px", minWidth: 0 }}>
        {!summary ? <EmptyState title="Enter the loan's original terms" detail="Original amount, rate, term, and start date are all required to rebuild the schedule and split it into paid-to-date and remaining." /> : <>
          <div style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface, color: PT.text, fontSize: "13px" }}>Paid to date vs. remaining · {summary.elapsedMonths} of {summary.elapsedMonths + summary.remainingMonths} payments made</div>
            <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
              <StatCell label="SCHEDULED BALANCE ESTIMATE" value={money(summary.currentBalance)} detail="Assumes scheduled payments only; compare with your lender payoff balance" />
              <StatCell label="INTEREST PAID SO FAR" value={money(summary.paidToDate.interest)} tone={PT.amber} detail="Sunk — unaffected by refinancing" />
              <StatCell label="PRINCIPAL PAID SO FAR" value={money(summary.paidToDate.principal)} />
              <StatCell label="INTEREST LEFT AT CURRENT RATE" value={summary.remainingMonths > 0 ? money(summary.remaining.interest) : "0"} detail={summary.remainingMonths > 0 ? `Over ${summary.remainingMonths} remaining months` : "Loan is paid off"} />
            </div>
          </div>

          <div style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px", display: "grid", gap: "12px" }}>
            <h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Refinance at today's rate</h2>
            {summary.remainingMonths <= 0 ? <EmptyState title="Nothing left to refinance" detail="This loan is already paid off under its original term." /> : market === "bengaluru" ? <EmptyState title="No US rate benchmark for this market" detail="Today's 30-yr rate context is a US FRED series and doesn't apply to Bengaluru; amortization above still works, refinance breakeven does not." /> : <>
              <div style={{ color: PT.textSub, fontSize: "10px" }}>{fredRate ? `Today's FRED 30-yr average: ${fredRate.value.toFixed(2)}% (as of ${fredRate.asOf})` : fredError || "Loading today's rate…"}</div>
              <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <PropertyField name="newAnnualRatePct" label="New rate %" placeholder={fredRate ? fredRate.value.toFixed(2) : "Today's FRED rate"} numeric value={refiField("newAnnualRatePct") || (fredRate ? fredRate.value.toFixed(2) : "")} onChange={changeRefi} />
                <PropertyField name="newTermYears" label="New term (years)" placeholder="30" numeric value={refiField("newTermYears")} onChange={changeRefi} />
              </div>
              <PropertyField name="closingCosts" label="Closing costs" hint="Defaults to 2% of the current balance; overwrite with a real quote." numeric value={refiField("closingCosts")} onChange={(k, v) => { changeRefi(k, v); changeRefi("closingCostsTouched", "yes"); }} />
              {refinance ? <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", border: `1px solid ${PT.border}`, borderRadius: "6px", overflow: "hidden" }}>
                <StatCell label="MONTHLY PAYMENT CHANGE" value={`${refinance.initialMonthlySavings >= 0 ? "-" : "+"}${money(Math.abs(refinance.initialMonthlySavings))}`} tone={refinance.initialMonthlySavings >= 0 ? PT.accent : PT.red} detail={refinance.initialMonthlySavings >= 0 ? "Lower payment" : "Higher payment"} />
                <StatCell label="MONTHS TO BREAK EVEN" value={refinance.breakevenMonth == null ? "Never" : String(refinance.breakevenMonth)} tone={refinance.breakevenMonth == null ? PT.red : PT.text} detail="From closing, not from the loan's start" />
                <StatCell label="LIFETIME SAVING" value={`${refinance.terminalUndiscountedBenefit >= 0 ? "" : "-"}${money(Math.abs(refinance.terminalUndiscountedBenefit))}`} tone={refinance.terminalUndiscountedBenefit >= 0 ? PT.accent : PT.red} detail={refinance.terminalUndiscountedBenefit >= 0 ? "Over the comparison window" : "Costs more than it saves"} />
              </div> : <EmptyState title="Enter a new rate, term, and closing cost" detail="All three are required to compare against the current loan." />}
            </>}
          </div>
        </>}
      </section>
    </div>
  </PropertyPageFrame>;
}
