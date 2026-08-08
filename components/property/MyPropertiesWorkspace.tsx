"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";
import { usePropertyMarket } from "@/lib/property/market-context";
import { calculateOwnershipCost } from "@/lib/property/ownership-cost";

type PropertyDraft = {
  id: string; name: string; market: PropertyMarketId; use: "Home" | "Rental" | "Land"; status: "Owned" | "Watching";
  value?: number; loan?: number; monthlyCost?: number; postalCode?: string; geocodeState?: "resolved" | "no_match" | "ambiguous" | "unavailable";
};

const currencyFor = (market: PropertyMarketId) => market === "bengaluru" ? "INR" : "USD";
const marketLabel = (market: PropertyMarketId) => PROPERTY_MARKETS.find((entry) => entry.id === market)?.label ?? market;
const numeric = (value: unknown) => { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : 0; };

function carryingCost(details: any): number {
  try {
    return calculateOwnershipCost({
      loanBalance: numeric(details?.loan), annualMortgageRatePct: numeric(details?.mortgageRatePct),
      remainingTermMonths: Math.max(1, Math.round(numeric(details?.remainingTermMonths) || 360)),
      annualPropertyTax: numeric(details?.annualPropertyTax), annualInsurance: numeric(details?.annualInsurance),
      annualMaintenance: numeric(details?.annualMaintenance), monthlyHoa: numeric(details?.monthlyHoa), monthlyOther: numeric(details?.monthlyOther),
    }).total;
  } catch { return 0; }
}

export default function MyPropertiesWorkspace() {
  const { market, setMarket } = usePropertyMarket();
  const [items, setItems] = useState<PropertyDraft[]>([]);
  const [name, setName] = useState("");
  const [use, setUse] = useState<PropertyDraft["use"]>("Home");
  const [status, setStatus] = useState<PropertyDraft["status"]>("Owned");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [encryptionReady, setEncryptionReady] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  const field = (key: string) => fields[key] ?? "";
  const change = (key: string, value: string) => setFields((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    fetch("/api/property/assets").then(async (response) => {
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Property records unavailable");
      setEncryptionReady(Boolean(payload.encryptionReady));
      setItems((payload.assets ?? []).map((row: any) => ({
        id: row.id, name: row.display_label, market: row.geography_slug as PropertyMarketId,
        use: row.asset_type === "rental" ? "Rental" : row.asset_type === "land" ? "Land" : "Home",
        status: row.details?.status === "Watching" ? "Watching" : "Owned", value: row.details?.value, loan: row.details?.loan,
        monthlyCost: carryingCost(row.details), postalCode: row.details?.geocode?.postalCode ?? row.details?.address?.postalCode,
        geocodeState: row.details?.geocode?.state,
      })));
    }).catch((error) => { setEncryptionReady(false); setMessage(error instanceof Error ? error.message : "Property records unavailable"); });
  }, []);

  const owned = useMemo(() => items.filter((item) => item.status === "Owned"), [items]);
  const knownEquity = useMemo(() => owned.reduce((sum, item) => sum + Math.max(0, (item.value ?? 0) - (item.loan ?? 0)), 0), [owned]);
  const mixedCurrencies = new Set(owned.map((item) => currencyFor(item.market))).size > 1;

  async function addProperty() {
    if (!name.trim()) return;
    setMessage("");
    const details = {
      status, value: field("value") || undefined, loan: field("loan") || undefined,
      mortgageRatePct: field("rate") || undefined, remainingTermMonths: field("years") ? Number(field("years")) * 12 : undefined,
      annualPropertyTax: field("tax") || undefined, annualInsurance: field("insurance") || undefined,
      annualMaintenance: field("maintenance") || undefined, monthlyHoa: field("hoa") || undefined, monthlyOther: field("other") || undefined,
      address: { addressLine: field("address"), city: field("city"), region: field("region"), postalCode: field("postal") },
    };
    const response = await fetch("/api/property/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayLabel: name.trim(), market, assetType: use.toLowerCase(), details }) });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error ?? "Property could not be saved"); return; }
    setItems((current) => [...current, { id: payload.id, name: name.trim(), market, use, status, value: field("value") ? Number(field("value")) : undefined, loan: field("loan") ? Number(field("loan")) : undefined, monthlyCost: carryingCost(details), postalCode: payload.geocode?.postalCode ?? field("postal"), geocodeState: payload.geocode?.state }]);
    setName(""); setFields({});
  }

  async function removeProperty(id: string) {
    const response = await fetch(`/api/property/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) setItems((current) => current.filter((entry) => entry.id !== id));
  }

  const Input = ({ name: key, label, placeholder, hint, numeric: isNumeric = false }: { name: string; label: string; placeholder?: string; hint?: string; numeric?: boolean }) => (
    <FieldLabel label={label} hint={hint}><input aria-label={label} inputMode={isNumeric ? "decimal" : "text"} value={field(key)} onChange={(event) => change(key, event.target.value)} placeholder={placeholder} style={fieldStyle} /></FieldLabel>
  );

  return <PropertyPageFrame eyebrow="Private workspace" title="My properties" description="Track an exact property, its equity, and its source-labeled monthly carrying cost without mixing currencies.">
    <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
      <StatCell label="OWNED" value={String(owned.length)} /><StatCell label="WATCHING" value={String(items.length - owned.length)} />
      <StatCell label="KNOWN EQUITY" value={mixedCurrencies ? "Split by market" : owned.length ? knownEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"} detail={mixedCurrencies ? "USD and INR are never summed" : owned[0] ? currencyFor(owned[0].market) : "No values entered"} />
      <StatCell label="STORAGE" value={encryptionReady ? "Encrypted" : encryptionReady === null ? "Checking" : "Locked"} tone={encryptionReady ? PT.accent : PT.amber} detail={encryptionReady ? "AES-256-GCM, owner-only" : "Server encryption key required"} />
    </div>
    <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(300px, 390px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
      <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}><Plus size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Add property</h2></div>
        <div style={{ display: "grid", gap: "12px" }}>
          <FieldLabel label="Nickname"><input aria-label="Property nickname" value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Austin home" style={fieldStyle} /></FieldLabel>
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <FieldLabel label="Market"><select value={market} onChange={(event) => setMarket(event.target.value as PropertyMarketId)} style={fieldStyle}>{PROPERTY_MARKETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.country === "US" ? "US" : "India"} - {entry.label}</option>)}</select></FieldLabel>
            <FieldLabel label="Use"><select value={use} onChange={(event) => setUse(event.target.value as PropertyDraft["use"])} style={fieldStyle}><option>Home</option><option>Rental</option><option>Land</option></select></FieldLabel>
          </div>
          <FieldLabel label="Status"><select value={status} onChange={(event) => setStatus(event.target.value as PropertyDraft["status"])} style={fieldStyle}><option>Owned</option><option>Watching</option></select></FieldLabel>
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><Input name="value" label={`Your value (${currencyFor(market)})`} placeholder="Optional" numeric /><Input name="loan" label={`Loan balance (${currencyFor(market)})`} placeholder="Optional" numeric /></div>
          <Input name="address" label={market === "bengaluru" ? "Exact address or locality" : "Exact property address"} placeholder={market === "bengaluru" ? "Street/locality (optional)" : "Street and unit"} hint="Encrypted at rest; never sent to an LLM." />
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><Input name="city" label="City" placeholder={marketLabel(market)} /><Input name="region" label="State" placeholder={market === "bengaluru" ? "Karnataka" : market === "phoenix" ? "AZ" : "TX"} /><Input name="postal" label={market === "bengaluru" ? "PIN" : "ZIP"} placeholder={market === "bengaluru" ? "560001" : "78701"} numeric /></div>
          <div style={{ color: PT.muted, fontSize: "9px", lineHeight: 1.5 }}>ZIP/PIN is enough for market exploration. Exact address is optional for an owned property; US county geography is resolved in the background.</div>
          <div style={{ borderTop: `1px solid ${PT.border}`, paddingTop: "12px", color: PT.text, fontSize: "11px", fontWeight: 700 }}>Monthly carrying cost</div>
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><Input name="rate" label="Mortgage rate %" placeholder="Statement" numeric /><Input name="years" label="Years remaining" placeholder="30" numeric /><Input name="tax" label={`Annual property tax (${currencyFor(market)})`} placeholder="Tax bill/estimate" numeric /><Input name="insurance" label={`Annual insurance (${currencyFor(market)})`} placeholder="Quote/policy" numeric /><Input name="maintenance" label={`Annual maintenance (${currencyFor(market)})`} placeholder="Planning assumption" numeric /><Input name="hoa" label={`Monthly HOA (${currencyFor(market)})`} placeholder="0" numeric /><Input name="other" label={`Other monthly (${currencyFor(market)})`} placeholder="Utilities/fees" numeric /></div>
          <button type="button" onClick={addProperty} disabled={!name.trim()} style={{ ...buttonStyle, opacity: name.trim() ? 1 : .45 }}>Add property</button>
          {message ? <div role="alert" style={{ color: PT.amber, fontSize: "10px" }}>{message}</div> : null}
          <LocalOnlyNotice>Private fields are encrypted before database storage. Tax and insurance remain owner-entered until an official bill or insurer quote is connected; Kairos does not present ZIP averages as exact costs.</LocalOnlyNotice>
        </div>
      </section>
      <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><Building2 size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Tracked properties</h2></div>
        {items.length === 0 ? <EmptyState title="No property records" detail="Add a property to track its private address, equity, and carrying costs." /> : <div>
          <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1.3fr .8fr .7fr .8fr .8fr .9fr 28px", gap: "10px", padding: "9px 13px", borderBottom: `1px solid ${PT.border}`, color: PT.muted, fontSize: "9px", fontWeight: 800 }}><span>PROPERTY</span><span>MARKET</span><span>USE</span><span>STATUS</span><span>EQUITY</span><span>MONTHLY COST</span><span /></div>
          {items.map((item) => { const equity = item.value == null ? null : Math.max(0, item.value - (item.loan ?? 0)); return <div className="property-table-row" key={item.id} style={{ display: "grid", gridTemplateColumns: "1.3fr .8fr .7fr .8fr .8fr .9fr 28px", gap: "10px", alignItems: "center", padding: "12px 13px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "11px" }}>
            <strong data-label="PROPERTY" style={{ color: PT.text }}>{item.name}<small style={{ display: "block", color: item.geocodeState === "resolved" ? PT.accent : PT.muted, fontSize: "9px", marginTop: "3px" }}>{item.postalCode ? `${item.postalCode} · ` : ""}{item.geocodeState === "resolved" ? "address resolved" : item.geocodeState ? `address ${item.geocodeState.replace("_", " ")}` : "address not linked"}</small></strong>
            <span data-label="MARKET">{marketLabel(item.market)}</span><span data-label="USE">{item.use}</span><span data-label="STATUS">{item.status}</span><span data-label="EQUITY">{equity == null ? "—" : `${currencyFor(item.market)} ${equity.toLocaleString()}`}</span><span data-label="MONTHLY COST">{item.monthlyCost ? `${currencyFor(item.market)} ${item.monthlyCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}</span><button type="button" title="Remove record" aria-label={`Remove ${item.name}`} onClick={() => removeProperty(item.id)} style={{ border: 0, background: "transparent", color: PT.muted, padding: "8px", cursor: "pointer", justifySelf: "end" }}><Trash2 size={14} /></button>
          </div>; })}
        </div>}
      </section>
    </div>
  </PropertyPageFrame>;
}
