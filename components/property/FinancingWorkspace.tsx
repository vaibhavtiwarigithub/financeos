"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Calculator, Landmark, Loader2, Plus, RotateCcw } from "lucide-react";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { buildAmortizationSchedule, calculateMortgage, evaluateRateShock, evaluateRefinance } from "@/lib/property/scenarios";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

// This page carried a private `payment()` helper and a hand-rolled amortization
// loop. Two implementations of the same formula drift apart silently, so both
// are gone: every number on this screen now comes from the exported engine in
// lib/property/scenarios.ts — the same code the server-side scenario routes use.
//
// /api/property/financing stores only the ENCRYPTED inputs; it computes nothing.
// So there is no server-returned result to render here — the engine is called
// client-side, but it is the identical engine, and it is deterministic, so a
// saved record recomputes to exactly the figures it was saved with.

const FINANCING_TYPES = [
  { id: "mortgage", label: "Mortgage", kind: "amortizing" },
  { id: "home_loan", label: "Home loan", kind: "amortizing" },
  { id: "refinance_quote", label: "Refinance", kind: "refinance" },
  { id: "heloc", label: "HELOC", kind: "revolving" },
  { id: "loan_against_property", label: "Loan against property", kind: "revolving" },
] as const;

type FinancingType = (typeof FINANCING_TYPES)[number]["id"];
type Kind = (typeof FINANCING_TYPES)[number]["kind"];

// Persisted shape. Deliberately terms-only: no account number, no address, no
// owner name ever leaves this form, encrypted or not.
type FinancingDetails = {
  market?: PropertyMarketId;
  balance?: number;
  annualRatePct?: number;
  termMonths?: number;
  newAnnualRatePct?: number;
  newTermMonths?: number;
  closingCosts?: number;
  rateShockBps?: number;
};

type SavedAccount = {
  id: string;
  financing_type: FinancingType;
  display_label: string;
  details: FinancingDetails | null;
  created_at: string;
  updated_at: string;
};

function kindOf(type: FinancingType): Kind {
  return FINANCING_TYPES.find((t) => t.id === type)!.kind;
}

function currencyFor(market: PropertyMarketId): "USD" | "INR" {
  return PROPERTY_MARKETS.find((m) => m.id === market)?.currency ?? "USD";
}

function money(value: number, currency: string): string {
  return value.toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: 0 });
}

export default function FinancingWorkspace() {
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [encryptionReady, setEncryptionReady] = useState(true);

  const [financingType, setFinancingType] = useState<FinancingType>("mortgage");
  const [market, setMarket] = useState<PropertyMarketId>("austin");
  const [label, setLabel] = useState("");
  const [balance, setBalance] = useState("400000");
  const [rate, setRate] = useState("6.5");
  const [years, setYears] = useState("30");
  const [newRate, setNewRate] = useState("5.75");
  const [newYears, setNewYears] = useState("30");
  const [closingCosts, setClosingCosts] = useState("6000");
  const [shockBps, setShockBps] = useState("200");

  const kind = kindOf(financingType);
  const currency = currencyFor(market);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/property/financing", { cache: "no-store" });
      const json = await response.json().catch(() => ({}));
      // A 5xx must never look like "you have no records" — those are different facts.
      if (!response.ok) throw new Error(json.error ?? `Saved financing records unavailable (HTTP ${response.status})`);
      setAccounts(json.accounts ?? []);
      setEncryptionReady(json.encryptionReady !== false);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Saved financing records unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const detailsFromForm = useCallback((): FinancingDetails => ({
    market,
    balance: Number(balance),
    annualRatePct: Number(rate),
    termMonths: Math.round(Number(years) * 12),
    ...(kind === "refinance"
      ? { newAnnualRatePct: Number(newRate), newTermMonths: Math.round(Number(newYears) * 12), closingCosts: Number(closingCosts) }
      : {}),
    ...(kind === "revolving" ? { rateShockBps: Number(shockBps) } : {}),
  }), [market, balance, rate, years, newRate, newYears, closingCosts, shockBps, kind]);

  // Every figure below is produced by the shared engine. The engine throws
  // RangeError on inputs it cannot honestly evaluate (zero balance, fractional
  // term), so an invalid form renders a stated reason instead of a stale number.
  const calc = useMemo(() => evaluate(financingType, detailsFromForm()), [financingType, detailsFromForm]);

  async function save() {
    if (!label.trim() || calc.state !== "ok") return;
    setSaving(true); setSaveError(null);
    try {
      const response = await fetch("/api/property/financing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ financingType, displayLabel: label.trim(), details: detailsFromForm() }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? `Financing record could not be saved (HTTP ${response.status})`);
      setLabel("");
      await load();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Financing record could not be saved");
    } finally {
      setSaving(false);
    }
  }

  function loadRecord(account: SavedAccount) {
    const d = account.details ?? {};
    setFinancingType(account.financing_type);
    if (d.market) setMarket(d.market);
    if (d.balance != null) setBalance(String(d.balance));
    if (d.annualRatePct != null) setRate(String(d.annualRatePct));
    if (d.termMonths != null) setYears(String(d.termMonths / 12));
    if (d.newAnnualRatePct != null) setNewRate(String(d.newAnnualRatePct));
    if (d.newTermMonths != null) setNewYears(String(d.newTermMonths / 12));
    if (d.closingCosts != null) setClosingCosts(String(d.closingCosts));
    if (d.rateShockBps != null) setShockBps(String(d.rateShockBps));
  }

  const savedCurrencies = useMemo(
    () => new Set(accounts.map((a) => currencyFor(a.details?.market ?? "austin"))),
    [accounts],
  );

  return (
    <PropertyPageFrame
      eyebrow="Scenario calculator"
      title="Financing"
      description="Model mortgage, refinance, and revolving-credit mechanics from terms you already hold. Nothing here is a lender quote, an offer, or a recommendation."
    >
      <div style={{ padding: "12px 28px", borderBottom: `1px solid ${PT.border}`, display: "flex", gap: "6px", flexWrap: "wrap" }}>
        {FINANCING_TYPES.map((item) => (
          <button type="button" key={item.id} onClick={() => setFinancingType(item.id)}
            style={{ minHeight: "32px", padding: "6px 12px", borderRadius: "6px", border: `1px solid ${financingType === item.id ? PT.accent : PT.border}`, background: financingType === item.id ? `${PT.accent}14` : "transparent", color: financingType === item.id ? PT.accent : PT.textSub, fontSize: "11px", fontWeight: 700, cursor: "pointer" }}>
            {item.label}
          </button>
        ))}
      </div>

      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        {calc.state !== "ok" ? (
          <>
            <StatCell label="SCENARIO" value="Inputs incomplete" tone={PT.amber} detail={calc.message} />
            <StatCell label="—" value="—" />
            <StatCell label="—" value="—" />
            <StatCell label="SAVED RECORDS" value={loading ? "…" : String(accounts.length)} detail="Owner-encrypted terms only" />
          </>
        ) : calc.kind === "refinance" ? (
          <>
            <StatCell label="NEW PAYMENT / MONTH" value={money(calc.refi.newMonthlyPayment, currency)} detail={`Replaces ${money(calc.refi.currentMonthlyPayment, currency)}`} />
            <StatCell label="MONTHLY SAVINGS" value={money(calc.refi.initialMonthlySavings, currency)} tone={calc.refi.initialMonthlySavings > 0 ? PT.accent : PT.red} />
            <StatCell label="FEE BREAK-EVEN" value={calc.refi.breakevenMonth == null ? "Never" : `${calc.refi.breakevenMonth} months`} tone={calc.refi.breakevenMonth == null ? PT.red : PT.text} detail="Engine result, not a curve read-off" />
            <StatCell label="NPV BENEFIT" value={money(calc.refi.npvBenefit, currency)} tone={calc.refi.isNpvPositive ? PT.accent : PT.red} detail="Undiscounted unless a discount rate is set" />
          </>
        ) : calc.kind === "revolving" ? (
          <>
            <StatCell label="INTEREST-ONLY / MONTH" value={money(calc.shock.currentMonthlyPayment, currency)} />
            <StatCell label={`AT +${shockBps} BPS`} value={money(calc.shock.shockedMonthlyPayment, currency)} tone={PT.amber} detail="Hypothetical rate move, not a forecast" />
            <StatCell label="ANNUAL COST CHANGE" value={money(calc.shock.annualPaymentChange, currency)} tone={calc.shock.annualPaymentChange > 0 ? PT.red : PT.accent} />
            <StatCell label="SAVED RECORDS" value={loading ? "…" : String(accounts.length)} detail="Owner-encrypted terms only" />
          </>
        ) : (
          <>
            <StatCell label="PRINCIPAL + INTEREST / MONTH" value={money(calc.summary.monthlyPayment, currency)} />
            <StatCell label="LIFETIME INTEREST" value={money(calc.summary.totalInterest, currency)} tone={PT.amber} />
            <StatCell label="TOTAL REPAID" value={money(calc.summary.totalPayment, currency)} />
            <StatCell label="SAVED RECORDS" value={loading ? "…" : String(accounts.length)} detail="Owner-encrypted terms only" />
          </>
        )}
      </div>

      {!encryptionReady ? (
        <div style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.amber}`, borderRadius: "6px", color: PT.amber, fontSize: "11px" }}>
          Financing storage is locked until <code>PROPERTY_DATA_ENCRYPTION_KEY</code> is configured. The calculator still runs; nothing will be written until a key exists, because terms are never stored unencrypted.
        </div>
      ) : null}
      {loadError ? (
        <div role="alert" style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.red}`, borderRadius: "6px", color: PT.red, fontSize: "11px" }}>{loadError}</div>
      ) : null}
      {saveError ? (
        <div role="alert" style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.red}`, borderRadius: "6px", color: PT.red, fontSize: "11px" }}>{saveError}</div>
      ) : null}

      <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(290px, 370px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}>
            {kind === "refinance" ? <RotateCcw size={15} color={PT.accent} /> : kind === "revolving" ? <Landmark size={15} color={PT.accent} /> : <Calculator size={15} color={PT.accent} />}
            <h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Terms</h2>
          </div>
          <div style={{ display: "grid", gap: "11px" }}>
            <FieldLabel label="Record label" hint="Stored unencrypted as a title. Never use an address, account number, or a person's name.">
              <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Example: Primary 30-year fixed" style={fieldStyle} />
            </FieldLabel>
            <FieldLabel label="Market" hint={`Sets the currency: ${currency}.`}>
              <select value={market} onChange={(e) => setMarket(e.target.value as PropertyMarketId)} style={fieldStyle}>
                {PROPERTY_MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.currency})</option>)}
              </select>
            </FieldLabel>
            <FieldLabel label={`${kind === "revolving" ? "Drawn balance" : "Loan balance"} (${currency})`}>
              <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} style={fieldStyle} />
            </FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label={kind === "refinance" ? "Current rate %" : "Annual rate %"}><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} style={fieldStyle} /></FieldLabel>
              {kind === "revolving" ? (
                <FieldLabel label="Rate shock (bps)"><input inputMode="numeric" value={shockBps} onChange={(e) => setShockBps(e.target.value)} style={fieldStyle} /></FieldLabel>
              ) : (
                <FieldLabel label={kind === "refinance" ? "Years remaining" : "Term years"}><input inputMode="numeric" value={years} onChange={(e) => setYears(e.target.value)} style={fieldStyle} /></FieldLabel>
              )}
            </div>
            {kind === "refinance" ? (
              <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <FieldLabel label="New rate %"><input inputMode="decimal" value={newRate} onChange={(e) => setNewRate(e.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label="New term years"><input inputMode="numeric" value={newYears} onChange={(e) => setNewYears(e.target.value)} style={fieldStyle} /></FieldLabel>
                <FieldLabel label={`Closing costs (${currency})`}><input inputMode="decimal" value={closingCosts} onChange={(e) => setClosingCosts(e.target.value)} style={fieldStyle} /></FieldLabel>
              </div>
            ) : null}
            <button type="button" onClick={() => void save()} disabled={saving || !encryptionReady || !label.trim() || calc.state !== "ok"}
              style={{ ...buttonStyle, display: "flex", justifyContent: "center", alignItems: "center", gap: "6px", opacity: (!saving && encryptionReady && label.trim() && calc.state === "ok") ? 1 : 0.45 }}>
              {saving ? <Loader2 size={14} /> : <Plus size={14} />}{saving ? "Saving" : "Save financing record"}
            </button>
            <LocalOnlyNotice>
              Terms are encrypted before they reach the database; the label is not. This model excludes tax, insurance, PMI, prepayment penalties, variable-rate resets, lender qualification, and India-specific loan terms.
            </LocalOnlyNotice>
          </div>
        </section>

        <div style={{ minWidth: 0, display: "grid", gap: "18px" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}>
              <h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>
                {calc.state === "ok" && calc.kind === "refinance" ? "Cumulative refinance benefit" : calc.state === "ok" && calc.kind === "revolving" ? "Rate sensitivity" : "Where each payment goes"}
              </h2>
              <div style={{ color: PT.muted, fontSize: "9px", marginTop: "3px" }}>
                {calc.state === "ok" && calc.kind === "refinance"
                  ? `Closing costs first, then monthly savings. Values in ${currency}. Both payments come from the engine; the break-even marker is the engine's own result, not read off the curve.`
                  : calc.state === "ok" && calc.kind === "revolving"
                    ? "A revolving balance has no payoff curve — future draws and repayments are unknown, so none is drawn."
                    : `Annual principal and interest split from the deterministic amortization schedule, in ${currency}. This is the contractual schedule for the terms entered, not a forecast.`}
              </div>
            </div>
            <div className="property-chart" style={{ height: "330px", padding: "18px 12px 8px" }}>
              {calc.state !== "ok" ? (
                <EmptyState title="Scenario cannot be evaluated" detail={calc.message} />
              ) : calc.kind === "revolving" ? (
                <div style={{ height: "100%", display: "grid", placeItems: "center", color: PT.muted, fontSize: "11px", textAlign: "center", padding: "20px" }}>
                  Interest-only cost moves linearly with the rate: {money(calc.shock.currentMonthlyPayment, currency)} today, {money(calc.shock.shockedMonthlyPayment, currency)} at +{shockBps} bps. A fixed payoff curve would imply a repayment schedule you have not committed to.
                </div>
              ) : calc.kind === "refinance" ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={calc.chart} margin={{ top: 8, right: 15, left: 4, bottom: 8 }}>
                    <CartesianGrid stroke={PT.border} vertical={false} />
                    <XAxis dataKey="month" tick={{ fill: PT.muted, fontSize: 10 }} label={{ value: "Month", position: "insideBottom", offset: -2, fill: PT.muted, fontSize: 10 }} />
                    <YAxis tick={{ fill: PT.muted, fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                    <Tooltip formatter={(v) => [money(Number(v), currency), "Cumulative benefit"]} labelFormatter={(l) => `Month ${l}`} contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} />
                    <ReferenceLine y={0} stroke={PT.muted} strokeDasharray="3 3" />
                    {calc.refi.breakevenMonth != null ? (
                      <ReferenceLine x={calc.refi.breakevenMonth} stroke={PT.accent} strokeDasharray="4 3" label={{ value: `Break-even ${calc.refi.breakevenMonth}`, fill: PT.accent, fontSize: 9, position: "top" }} />
                    ) : null}
                    <Line type="monotone" dataKey="cumulative" name="Cumulative benefit" stroke={PT.accent} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={calc.chart} margin={{ top: 8, right: 15, left: 4, bottom: 8 }}>
                    <defs>
                      <linearGradient id="propertyPrincipal" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PT.accent} stopOpacity={0.4} /><stop offset="100%" stopColor={PT.accent} stopOpacity={0.03} /></linearGradient>
                      <linearGradient id="propertyInterest" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={PT.amber} stopOpacity={0.4} /><stop offset="100%" stopColor={PT.amber} stopOpacity={0.03} /></linearGradient>
                    </defs>
                    <CartesianGrid stroke={PT.border} vertical={false} />
                    <XAxis dataKey="year" tick={{ fill: PT.muted, fontSize: 10 }} label={{ value: "Year", position: "insideBottom", offset: -2, fill: PT.muted, fontSize: 10 }} />
                    <YAxis tick={{ fill: PT.muted, fontSize: 10 }} tickFormatter={(v) => `${Math.round(Number(v) / 1000)}k`} />
                    <Tooltip formatter={(v, n) => [money(Number(v), currency), n]} labelFormatter={(l) => `Year ${l}`} contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} />
                    <Legend wrapperStyle={{ fontSize: "10px", color: PT.textSub }} />
                    <Area type="monotone" dataKey="interest" name="Interest" stackId="1" stroke={PT.amber} fill="url(#propertyInterest)" strokeWidth={2} />
                    <Area type="monotone" dataKey="principal" name="Principal" stackId="1" stroke={PT.accent} fill="url(#propertyPrincipal)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1.3fr .9fr .8fr 1fr .6fr", gap: "8px", padding: "9px 12px", color: PT.muted, fontSize: "9px", fontWeight: 800, borderBottom: `1px solid ${PT.border}` }}>
              <span>LABEL</span><span>TYPE</span><span>MARKET</span><span>BALANCE</span><span></span>
            </div>
            {loading ? (
              <EmptyState title="Loading saved financing" detail="Reading your encrypted financing terms." />
            ) : loadError ? (
              <EmptyState title="Saved financing could not be read" detail="The list above is not empty — it is unavailable. See the error banner." />
            ) : accounts.length === 0 ? (
              <EmptyState title="No saved financing records" detail="Save the terms you already hold so the calculator reopens with them. Terms are encrypted; only the label is stored in the clear." />
            ) : accounts.map((account) => {
              const d = account.details ?? {};
              // Each row prints its own currency. USD and INR are never summed
              // and never share the chart axis — the chart shows one record's
              // scenario at a time, in that record's own currency.
              const rowCurrency = currencyFor(d.market ?? "austin");
              return (
                <div className="property-table-row" key={account.id} style={{ display: "grid", gridTemplateColumns: "1.3fr .9fr .8fr 1fr .6fr", gap: "8px", alignItems: "center", padding: "12px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}>
                  <span data-label="ACCOUNT" style={{ color: PT.text, overflowWrap: "anywhere" }}>{account.display_label}</span>
                  <span data-label="TYPE">{FINANCING_TYPES.find((t) => t.id === account.financing_type)?.label ?? account.financing_type}</span>
                  <span data-label="MARKET">{PROPERTY_MARKETS.find((m) => m.id === d.market)?.label ?? "—"}</span>
                  <span data-label="BALANCE">{d.balance != null ? money(d.balance, rowCurrency) : "—"}</span>
                  <button type="button" onClick={() => loadRecord(account)} style={{ minHeight: "28px", border: `1px solid ${PT.border}`, borderRadius: "5px", background: "transparent", color: PT.blue, fontSize: "10px", fontWeight: 700, cursor: "pointer" }}>Open</button>
                </div>
              );
            })}
            {savedCurrencies.size > 1 ? (
              <div style={{ padding: "9px 12px", color: PT.muted, fontSize: "9px" }}>USD and INR records are listed together but never totalled or charted on one axis.</div>
            ) : null}
          </section>
        </div>
      </div>
    </PropertyPageFrame>
  );
}

type Evaluation =
  | { state: "invalid"; message: string }
  | { state: "ok"; kind: "amortizing"; summary: ReturnType<typeof calculateMortgage>; chart: Array<{ year: number; principal: number; interest: number }> }
  | { state: "ok"; kind: "refinance"; refi: ReturnType<typeof evaluateRefinance>; chart: Array<{ month: number; cumulative: number }> }
  | { state: "ok"; kind: "revolving"; shock: ReturnType<typeof evaluateRateShock> };

function evaluate(financingType: FinancingType, d: FinancingDetails): Evaluation {
  const kind = kindOf(financingType);
  const balance = d.balance ?? 0;
  const annualRatePct = d.annualRatePct ?? 0;
  const termMonths = d.termMonths ?? 0;
  try {
    if (kind === "revolving") {
      const shockedAnnualRatePct = annualRatePct + (d.rateShockBps ?? 0) / 100;
      return { state: "ok", kind, shock: evaluateRateShock({ instrument: financingType === "heloc" ? "heloc" : "lap", balance, currentAnnualRatePct: annualRatePct, shockedAnnualRatePct, repaymentMode: "interest_only" }) };
    }
    if (kind === "refinance") {
      const newTermMonths = d.newTermMonths ?? 0;
      const refi = evaluateRefinance({
        balance,
        currentAnnualRatePct: annualRatePct,
        currentRemainingMonths: termMonths,
        newAnnualRatePct: d.newAnnualRatePct ?? 0,
        newTermMonths,
        closingCosts: d.closingCosts ?? 0,
      });
      // The two level payments are the engine's own outputs, so accumulating
      // them reproduces the exact series evaluateRefinance walked internally —
      // the curve cannot disagree with the break-even month reported above.
      const horizon = Math.max(termMonths, newTermMonths);
      const chart: Array<{ month: number; cumulative: number }> = [{ month: 0, cumulative: -(d.closingCosts ?? 0) }];
      let cumulative = -(d.closingCosts ?? 0);
      for (let month = 1; month <= horizon; month += 1) {
        cumulative += (month <= termMonths ? refi.currentMonthlyPayment : 0) - (month <= newTermMonths ? refi.newMonthlyPayment : 0);
        // Plot quarterly, plus the break-even month itself and the endpoint, so
        // a 360-month horizon stays legible without hiding the crossing.
        if (month % 3 === 0 || month === horizon || month === refi.breakevenMonth) chart.push({ month, cumulative });
      }
      return { state: "ok", kind, refi, chart };
    }
    const summary = calculateMortgage({ principal: balance, annualRatePct, termMonths });
    const byYear = new Map<number, { year: number; principal: number; interest: number }>();
    for (const row of buildAmortizationSchedule({ principal: balance, annualRatePct, termMonths })) {
      const year = Math.ceil(row.month / 12);
      const bucket = byYear.get(year) ?? { year, principal: 0, interest: 0 };
      bucket.principal += row.principal;
      bucket.interest += row.interest;
      byYear.set(year, bucket);
    }
    return { state: "ok", kind, summary, chart: [...byYear.values()] };
  } catch (error) {
    return { state: "invalid", message: error instanceof RangeError ? `Engine rejected the inputs: ${error.message}.` : "These terms cannot be evaluated." };
  }
}
