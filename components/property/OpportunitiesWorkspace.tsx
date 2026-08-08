"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, Calculator, Loader2, Plus } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { calculateMortgage, type RentalEconomicsResult } from "@/lib/property/scenarios";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";
import { usePropertyMarket } from "@/lib/property/market-context";

// Scenarios are computed by the SERVER engine (lib/property/scenarios.ts) and
// persisted; this component renders what came back. It previously carried its
// own inline cap-rate and amortization math, which meant two implementations of
// the same formula could drift apart silently — the displayed number and the
// stored number would then disagree with no way to tell which was right.
//
// The one exception is the amortization used to DERIVE annual debt service from
// the rate and down payment the owner typed. That is a pure input transform, and
// it reuses the very same exported `calculateMortgage` the server uses, so there
// is still only one implementation.

type SavedScenario = {
  id: string;
  geography_slug: PropertyMarketId;
  scenario_type: string;
  result_json: RentalEconomicsResult;
  decision_state: string;
  created_at: string;
};

const DECISION_TONE: Record<string, string> = {
  actionable: PT.accent,
  watch: PT.amber,
  not_economic_under_assumptions: PT.red,
  insufficient_inputs: PT.muted,
};

function currencyFor(market: PropertyMarketId): string {
  return PROPERTY_MARKETS.find((m) => m.id === market)?.currency ?? "USD";
}

export default function OpportunitiesWorkspace() {
  const { market, setMarket } = usePropertyMarket();
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [encryptionReady, setEncryptionReady] = useState(true);

  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [rent, setRent] = useState("");
  const [annualCosts, setAnnualCosts] = useState("");
  const [vacancyPct, setVacancyPct] = useState("5");
  const [downPct, setDownPct] = useState("20");
  const [rate, setRate] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/property/scenarios", { cache: "no-store" });
      if (!response.ok) throw new Error(`Saved scenarios unavailable (HTTP ${response.status})`);
      const json = await response.json();
      setScenarios((json.scenarios ?? []).filter((s: SavedScenario) => s.scenario_type === "rent"));
      setEncryptionReady(json.encryptionReady !== false);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Saved scenarios unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveScenario() {
    const purchasePrice = Number(price);
    if (!name.trim() || !Number.isFinite(purchasePrice) || purchasePrice <= 0) return;
    setSaving(true); setError(null);

    const downPayment = purchasePrice * (Number(downPct) || 0) / 100;
    // Same amortization the server uses — imported, not re-derived.
    const annualDebtService = downPayment < purchasePrice
      ? calculateMortgage({ principal: purchasePrice - downPayment, annualRatePct: Number(rate) || 0, termMonths: 360 }).monthlyPayment * 12
      : 0;

    try {
      const response = await fetch("/api/property/scenarios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market,
          scenarioType: "rent",
          label: name.trim(),
          inputs: {
            label: name.trim(),
            purchasePrice,
            cashInvested: downPayment,
            monthlyGrossRent: Number(rent) || 0,
            vacancyPct: Number(vacancyPct) || 0,
            annualOperatingExpenses: Number(annualCosts) || 0,
            annualDebtService,
          },
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error ?? `Scenario could not be saved (HTTP ${response.status})`);
      setName(""); setPrice(""); setRent(""); setAnnualCosts("");
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Scenario could not be saved");
    } finally {
      setSaving(false);
    }
  }

  // USD and INR must never share an axis or a total.
  const currencies = useMemo(() => new Set(scenarios.map((s) => currencyFor(s.geography_slug))), [scenarios]);
  const comparable = currencies.size <= 1;

  const chartData = useMemo(() => scenarios.map((s) => ({
    name: new Date(s.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    cashFlow: Math.round(Number(s.result_json?.annualCashFlow ?? 0)),
  })), [scenarios]);

  const actionable = scenarios.filter((s) => s.decision_state === "actionable").length;

  return (
    <PropertyPageFrame eyebrow="Decision lab" title="Opportunities" description="Compare user-entered deal assumptions with deterministic rental math. This page does not discover listings or estimate market prices.">
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="SAVED SCENARIOS" value={loading ? "…" : String(scenarios.length)} detail="Persisted, owner-encrypted" />
        <StatCell label="ACTIONABLE" value={loading ? "…" : String(actionable)} tone={actionable ? PT.accent : PT.muted} detail="Under your assumptions only" />
        <StatCell label="LIVE LISTINGS" value="Not connected" tone={PT.amber} />
        <StatCell label="CURRENCY CONTROL" value={comparable ? "Comparable" : "Market split"} tone={comparable ? PT.accent : PT.amber} detail="USD and INR never combine" />
      </div>

      {!encryptionReady ? (
        <div style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.amber}`, borderRadius: "6px", color: PT.amber, fontSize: "11px" }}>
          Scenario storage is locked until <code>PROPERTY_DATA_ENCRYPTION_KEY</code> is configured. Inputs are never written unencrypted.
        </div>
      ) : null}
      {error ? (
        <div role="alert" style={{ margin: "14px 28px 0", padding: "11px 13px", border: `1px solid ${PT.red}`, borderRadius: "6px", color: PT.red, fontSize: "11px" }}>{error}</div>
      ) : null}

      <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(290px, 370px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
        <section style={{ border: `1px solid ${PT.border}`, background: PT.surface, borderRadius: "7px", padding: "16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "14px" }}><Calculator size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Add deal assumptions</h2></div>
          <div style={{ display: "grid", gap: "11px" }}>
            <FieldLabel label="Scenario name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Example: North Austin duplex" style={fieldStyle} /></FieldLabel>
            <FieldLabel label="Market">
              <select value={market} onChange={(e) => setMarket(e.target.value as PropertyMarketId)} style={fieldStyle}>
                {PROPERTY_MARKETS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label="Purchase price"><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Required" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Monthly rent"><input inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Annual operating costs" hint="Tax, insurance, maintenance; exclude debt service and vacancy."><input inputMode="decimal" value={annualCosts} onChange={(e) => setAnnualCosts(e.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Vacancy %"><input inputMode="decimal" value={vacancyPct} onChange={(e) => setVacancyPct(e.target.value)} style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Down payment %"><input inputMode="decimal" value={downPct} onChange={(e) => setDownPct(e.target.value)} style={fieldStyle} /></FieldLabel>
              <FieldLabel label="Loan rate %"><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0" style={fieldStyle} /></FieldLabel>
            </div>
            <button type="button" onClick={() => void saveScenario()} disabled={saving || !encryptionReady || !name.trim() || Number(price) <= 0}
              style={{ ...buttonStyle, display: "flex", justifyContent: "center", alignItems: "center", gap: "6px", opacity: (!saving && encryptionReady && name.trim() && Number(price) > 0) ? 1 : 0.45 }}>
              {saving ? <Loader2 size={14} /> : <Plus size={14} />}{saving ? "Saving" : "Save scenario"}
            </button>
            <LocalOnlyNotice>Cap rate, cash-on-cash and DSCR are computed server-side by the deterministic engine and stored with your encrypted inputs. They exclude closing costs, income tax, appreciation, and market-specific legal constraints.</LocalOnlyNotice>
          </div>
        </section>

        <div style={{ minWidth: 0, display: "grid", gap: "18px" }}>
          <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
            <div style={{ padding: "13px 15px", display: "flex", gap: "8px", alignItems: "center", background: PT.surface, borderBottom: `1px solid ${PT.border}` }}><BarChart3 size={15} color={PT.blue} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Annual cash flow by scenario</h2></div>
            {loading ? <EmptyState title="Loading saved scenarios" detail="Reading your encrypted scenario history." />
              : scenarios.length === 0 ? <EmptyState title="No saved scenarios" detail="Enter a candidate using figures you already have. Listing discovery stays absent until a permitted provider is connected." />
              : !comparable ? <EmptyState title="Comparison split by currency" detail="USD and INR cash flows cannot share one scale. Filter to a single currency group to compare." />
              : (
                <div className="property-chart" style={{ padding: "16px", height: "260px" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 12 }}>
                      <CartesianGrid stroke={PT.border} vertical={false} />
                      <XAxis dataKey="name" tick={{ fill: PT.muted, fontSize: 10 }} />
                      <YAxis tick={{ fill: PT.muted, fontSize: 10 }} />
                      <Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "11px" }} />
                      <Bar dataKey="cashFlow" name="Annual cash flow" fill={PT.accent} radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
          </section>

          {scenarios.length ? (
            <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
              <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1fr .8fr .7fr .8fr .8fr 1fr", gap: "8px", padding: "9px 12px", color: PT.muted, fontSize: "9px", fontWeight: 800, borderBottom: `1px solid ${PT.border}` }}>
                <span>SAVED</span><span>MARKET</span><span>CAP RATE</span><span>CASH/CASH</span><span>DSCR</span><span>ANNUAL CASH FLOW</span>
              </div>
              {scenarios.map((s) => {
                const r = s.result_json ?? ({} as RentalEconomicsResult);
                const code = currencyFor(s.geography_slug);
                const cash = Number(r.annualCashFlow ?? 0);
                return (
                  <div className="property-table-row" key={s.id} style={{ display: "grid", gridTemplateColumns: "1fr .8fr .7fr .8fr .8fr 1fr", gap: "8px", alignItems: "center", padding: "12px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "10px" }}>
                    <span data-label="DATE / DECISION" title={s.decision_state} style={{ color: DECISION_TONE[s.decision_state] ?? PT.textSub }}>
                      {new Date(s.created_at).toLocaleDateString()} · {s.decision_state.replace(/_/g, " ")}
                    </span>
                    <span data-label="MARKET">{PROPERTY_MARKETS.find((m) => m.id === s.geography_slug)?.label ?? s.geography_slug}</span>
                    <span data-label="CAP RATE">{Number(r.capRatePct ?? 0).toFixed(2)}%</span>
                    <span data-label="CASH RETURN">{Number(r.cashOnCashReturnPct ?? 0).toFixed(2)}%</span>
                    <span data-label="DSCR">{r.dscr == null ? "—" : Number(r.dscr).toFixed(2)}</span>
                    <span data-label="ANNUAL CASH" style={{ color: cash >= 0 ? PT.accent : PT.red }}>{code} {Math.round(cash).toLocaleString()}</span>
                  </div>
                );
              })}
            </section>
          ) : null}
        </div>
      </div>
    </PropertyPageFrame>
  );
}
