"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, Building2, Pencil, Plus, X } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";
import { usePropertyMarket } from "@/lib/property/market-context";
import { calculateOwnershipCost } from "@/lib/property/ownership-cost";
import ValueIntelligencePanel from "./ValueIntelligencePanel";
import { ADDRESS_VERIFICATION_LABEL, type AddressVerification } from "@/lib/property/address-verify";
import ZipAreaTrend from "./ZipAreaTrend";

type PropertyDetails = {
  status?: "Owned" | "Watching";
  value?: number;
  loan?: number;
  mortgageRatePct?: number;
  remainingTermMonths?: number;
  annualPropertyTax?: number;
  annualInsurance?: number;
  annualMaintenance?: number;
  monthlyHoa?: number;
  monthlyOther?: number;
  address?: { addressLine?: string; city?: string; region?: string; postalCode?: string };
  geocode?: { state?: "resolved" | "no_match" | "ambiguous" | "unavailable"; postalCode?: string };
  addressVerification?: AddressVerification;
};

type PropertyRecord = {
  id: string;
  name: string;
  market: PropertyMarketId;
  use: "Home" | "Rental" | "Land";
  status: "Owned" | "Watching";
  details: PropertyDetails;
};

type PropertyHistory = {
  id: number;
  property_asset_id: string;
  as_of: string;
  snapshot: Omit<PropertyDetails, "address" | "geocode">;
};

const currencyFor = (market: PropertyMarketId) => market === "bengaluru" ? "INR" : "USD";
const marketLabel = (market: PropertyMarketId) => PROPERTY_MARKETS.find((entry) => entry.id === market)?.label ?? market;
const today = () => new Date().toISOString().slice(0, 10);
const numeric = (value: unknown) => { const result = Number(value); return Number.isFinite(result) && result >= 0 ? result : 0; };
const stringValue = (value: unknown) => value == null ? "" : String(value);

// Only a USPS match is green. Everything else is amber, because "we did not
// check" and "we checked and failed" must never look like a pass.
const verificationTone = (state: AddressVerification["state"] | undefined) => state === "verified" ? PT.accent : state ? PT.amber : PT.muted;
const VERIFICATION_STALE_DAYS = 180;
function verificationAge(verification: AddressVerification | undefined): string {
  if (!verification?.checkedAt) return "";
  const days = Math.floor((Date.now() - new Date(verification.checkedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return "";
  const checkedOn = verification.checkedAt.slice(0, 10);
  return days >= VERIFICATION_STALE_DAYS ? `Checked ${checkedOn} (${days} days ago — stale, re-check).` : `Checked ${checkedOn}.`;
}

function carryingCost(details: PropertyDetails): number | null {
  const hasRecordedCostInput = [details.loan, details.annualPropertyTax, details.annualInsurance, details.annualMaintenance, details.monthlyHoa, details.monthlyOther].some((value) => value != null);
  if (!hasRecordedCostInput) return null;
  try {
    return calculateOwnershipCost({
      loanBalance: numeric(details.loan), annualMortgageRatePct: numeric(details.mortgageRatePct),
      remainingTermMonths: Math.max(1, Math.round(numeric(details.remainingTermMonths) || 360)),
      annualPropertyTax: numeric(details.annualPropertyTax), annualInsurance: numeric(details.annualInsurance),
      annualMaintenance: numeric(details.annualMaintenance), monthlyHoa: numeric(details.monthlyHoa), monthlyOther: numeric(details.monthlyOther),
    }).total;
  } catch { return null; }
}

function historyPoints(history: PropertyHistory[]) {
  return history.map((entry) => ({
    asOf: entry.as_of,
    value: entry.snapshot.value ?? null,
    equity: entry.snapshot.value == null ? null : Math.max(0, entry.snapshot.value - numeric(entry.snapshot.loan)),
    monthlyCost: carryingCost(entry.snapshot),
  }));
}

type PropertyFieldProps = {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  numeric?: boolean;
  type?: "text" | "date";
  value: string;
  onChange: (key: string, value: string) => void;
};

// Defined at MODULE scope, not inside the workspace component.
//
// THE BUG THIS FIXES. This lived inside MyPropertiesWorkspace, so every render
// produced a NEW function identity. React compares element types by reference:
// a new type means unmount + remount, not update. Each keystroke called
// change() -> setFields -> re-render -> brand-new <Input>, so the DOM node was
// destroyed and rebuilt on every character. The focused element vanished mid-
// interaction, which is why "Value and cost as of" appeared not to open a date
// picker: the native picker belongs to the input node, and that node was
// replaced the moment any state changed. Every field on the form had the same
// defect; the date input is just where it is impossible to miss.
export function PropertyField({ name, label, placeholder, hint, numeric = false, type = "text", value, onChange }: PropertyFieldProps) {
  return (
    <FieldLabel label={label} hint={hint}>
      <input
        aria-label={label}
        type={type}
        inputMode={numeric ? "decimal" : undefined}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        placeholder={placeholder}
        // colorScheme tells the browser to paint its native calendar widget and
        // spinners for a dark surface. Without it the date field's picker icon
        // renders near-black on this background and reads as "no picker here".
        style={{ ...fieldStyle, colorScheme: "dark" }}
      />
    </FieldLabel>
  );
}

const ADDRESS_KEYS = new Set(["address", "city", "region", "postal"]);

export default function MyPropertiesWorkspace() {
  const { market, setMarket } = usePropertyMarket();
  const [items, setItems] = useState<PropertyRecord[]>([]);
  const [history, setHistory] = useState<PropertyHistory[]>([]);
  const [historyAssetId, setHistoryAssetId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [use, setUse] = useState<PropertyRecord["use"]>("Home");
  const [status, setStatus] = useState<PropertyRecord["status"]>("Owned");
  const [fields, setFields] = useState<Record<string, string>>({ asOf: today() });
  const [encryptionReady, setEncryptionReady] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");
  // Verification of the address currently typed in the form. Seeded from the
  // saved record when editing, and dropped the moment any address field changes
  // so a result never describes an address other than the one on screen.
  const [addressCheck, setAddressCheck] = useState<AddressVerification | null>(null);
  const [checkingAddress, setCheckingAddress] = useState(false);
  const field = (key: string) => fields[key] ?? "";
  const change = (key: string, value: string) => {
    if (ADDRESS_KEYS.has(key)) setAddressCheck(null);
    setFields((current) => ({ ...current, [key]: value }));
  };

  const loadRecords = useCallback(async () => {
    const response = await fetch("/api/property/assets", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? "Property records unavailable");
    setEncryptionReady(Boolean(payload.encryptionReady));
    const records = (payload.assets ?? []).map((row: any): PropertyRecord => ({
      id: row.id,
      name: row.display_label,
      market: row.geography_slug as PropertyMarketId,
      use: row.asset_type === "rental" ? "Rental" : row.asset_type === "land" ? "Land" : "Home",
      status: row.details?.status === "Watching" ? "Watching" : "Owned",
      details: row.details ?? {},
    }));
    setItems(records);
    setHistory((payload.history ?? []) as PropertyHistory[]);
    setHistoryAssetId((current) => current && records.some((record: PropertyRecord) => record.id === current) ? current : records[0]?.id ?? "");
  }, []);

  useEffect(() => {
    loadRecords().catch((error) => {
      setEncryptionReady(false);
      setMessage(error instanceof Error ? error.message : "Property records unavailable");
    });
  }, [loadRecords]);

  const owned = useMemo(() => items.filter((item) => item.status === "Owned"), [items]);
  const ownedWithValue = useMemo(() => owned.filter((item) => item.details.value != null), [owned]);
  const knownEquity = useMemo(() => ownedWithValue.reduce((sum, item) => sum + Math.max(0, numeric(item.details.value) - numeric(item.details.loan)), 0), [ownedWithValue]);
  const hasUnknownEquity = ownedWithValue.length !== owned.length;
  const mixedCurrencies = new Set(owned.map((item) => currencyFor(item.market))).size > 1;
  const selectedHistoryAsset = items.find((item) => item.id === historyAssetId) ?? null;
  const selectedHistory = useMemo(() => historyPoints(history.filter((entry) => entry.property_asset_id === historyAssetId)), [history, historyAssetId]);

  function resetForm() {
    setEditingId(null);
    setName("");
    setUse("Home");
    setStatus("Owned");
    setFields({ asOf: today() });
    setAddressCheck(null);
    setMessage("");
  }

  function beginEdit(item: PropertyRecord) {
    const details = item.details;
    setEditingId(item.id);
    setHistoryAssetId(item.id);
    setName(item.name);
    setMarket(item.market);
    setUse(item.use);
    setStatus(item.status);
    setFields({
      asOf: today(), value: stringValue(details.value), loan: stringValue(details.loan), rate: stringValue(details.mortgageRatePct),
      years: details.remainingTermMonths ? String(details.remainingTermMonths / 12) : "", tax: stringValue(details.annualPropertyTax),
      insurance: stringValue(details.annualInsurance), maintenance: stringValue(details.annualMaintenance), hoa: stringValue(details.monthlyHoa), other: stringValue(details.monthlyOther),
      address: details.address?.addressLine ?? "", city: details.address?.city ?? "", region: details.address?.region ?? "", postal: details.address?.postalCode ?? "",
    });
    setAddressCheck(details.addressVerification ?? null);
    setMessage("");
  }

  function detailsPayload() {
    return {
      status, value: field("value") || undefined, loan: field("loan") || undefined,
      mortgageRatePct: field("rate") || undefined, remainingTermMonths: field("years") ? Number(field("years")) * 12 : undefined,
      annualPropertyTax: field("tax") || undefined, annualInsurance: field("insurance") || undefined,
      annualMaintenance: field("maintenance") || undefined, monthlyHoa: field("hoa") || undefined, monthlyOther: field("other") || undefined,
      address: { addressLine: field("address"), city: field("city"), region: field("region"), postalCode: field("postal") },
    };
  }

  // Pre-save check. Saving re-verifies server-side regardless, so this is a
  // preview, not a gate — an unverified address still saves.
  async function checkAddress() {
    setCheckingAddress(true);
    setAddressCheck(null);
    try {
      const response = await fetch("/api/property/address-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, addressLine: field("address"), city: field("city"), region: field("region"), postalCode: field("postal") }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.verification) {
        setMessage(payload.error ?? "The address check could not run. Next: retry, or save anyway — the property is saved with an unverified address.");
        return;
      }
      setAddressCheck(payload.verification as AddressVerification);
    } catch {
      setMessage("The address check could not reach the server. Next: retry, or save anyway — the property is saved with an unverified address.");
    } finally {
      setCheckingAddress(false);
    }
  }

  async function saveProperty() {
    if (!name.trim()) return;
    setMessage("");
    const response = await fetch("/api/property/assets", {
      method: editingId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editingId, displayLabel: name.trim(), market, assetType: use.toLowerCase(), details: detailsPayload(), asOf: field("asOf") || undefined }),
    });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error ?? "Property could not be saved"); return; }
    await loadRecords();
    if (!editingId && payload.id) setHistoryAssetId(payload.id);
    resetForm();
  }

  async function archiveProperty(id: string) {
    const response = await fetch(`/api/property/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      setMessage(payload?.error ?? "Property could not be archived");
      return;
    }
    if (editingId === id) resetForm();
    await loadRecords();
  }


  return <PropertyPageFrame eyebrow="Private workspace" title="My properties" description="Track an exact property, its equity, and an append-only owner-recorded history without mixing currencies." help={{ whatItDoes: "Stores the property details, values, loan balance, and carrying costs you enter. Every save records an immutable encrypted snapshot; it does not create an automated home valuation.", whatToLookFor: ["Use the as-of date that matches the value or cost information you are recording.", "Known equity is value minus recorded loan balance, not a broker or lender figure.", "An incomplete monthly cost means an input is missing, not zero."] }}>
    <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
      <StatCell label="OWNED" value={String(owned.length)} /><StatCell label="WATCHING" value={String(items.length - owned.length)} />
      <StatCell label="KNOWN EQUITY" value={mixedCurrencies ? "Split by market" : ownedWithValue.length ? knownEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"} detail={mixedCurrencies ? "USD and INR are never summed" : hasUnknownEquity ? "Some owned values are missing" : ownedWithValue[0] ? currencyFor(ownedWithValue[0].market) : "No values entered"} />
      <StatCell label="STORAGE" value={encryptionReady ? "Encrypted" : encryptionReady === null ? "Checking" : "Locked"} tone={encryptionReady ? PT.accent : PT.amber} detail={encryptionReady ? "AES-256-GCM, owner-only" : "Server encryption key required"} />
    </div>
    <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(300px, 390px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
      <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>{editingId ? <Pencil size={15} color={PT.accent} /> : <Plus size={15} color={PT.accent} />}<h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{editingId ? "Edit property" : "Add property"}</h2></div>
          {editingId ? <button type="button" onClick={resetForm} title="Cancel editing" aria-label="Cancel editing" style={{ border: 0, background: "transparent", color: PT.muted, padding: "5px", cursor: "pointer" }}><X size={15} /></button> : null}
        </div>
        <div style={{ display: "grid", gap: "12px" }}>
          <FieldLabel label="Nickname"><input aria-label="Property nickname" value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Austin home" style={fieldStyle} /></FieldLabel>
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <FieldLabel label="Market"><select value={market} onChange={(event) => setMarket(event.target.value as PropertyMarketId)} style={fieldStyle}>{PROPERTY_MARKETS.map((entry) => <option key={entry.id} value={entry.id}>{entry.country === "US" ? "US" : "India"} - {entry.label}</option>)}</select></FieldLabel>
            <FieldLabel label="Use"><select value={use} onChange={(event) => setUse(event.target.value as PropertyRecord["use"])} style={fieldStyle}><option>Home</option><option>Rental</option><option>Land</option></select></FieldLabel>
          </div>
          <FieldLabel label="Status"><select value={status} onChange={(event) => setStatus(event.target.value as PropertyRecord["status"])} style={fieldStyle}><option>Owned</option><option>Watching</option></select></FieldLabel>
          <PropertyField name="asOf" type="date" label="Value and cost as of" hint="Every save creates an immutable history point." value={field("asOf")} onChange={change} />
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><PropertyField name="value" label={`Current owner estimate (${currencyFor(market)})`} hint="Your own current estimate, not a market appraisal. Add dated purchase, appraisal, or comparable evidence below." placeholder="Optional" numeric value={field("value")} onChange={change} /><PropertyField name="loan" label={`Loan balance (${currencyFor(market)})`} placeholder="Optional" numeric value={field("loan")} onChange={change} /></div>
          <PropertyField name="address" label={market === "bengaluru" ? "Exact address or locality" : "Exact property address"} placeholder={market === "bengaluru" ? "Street/locality (optional)" : "Street and unit"} hint="Encrypted at rest; never sent to an LLM." value={field("address")} onChange={change} />
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><PropertyField name="city" label="City" placeholder={marketLabel(market)} value={field("city")} onChange={change} /><PropertyField name="region" label="State" placeholder={market === "bengaluru" ? "Karnataka" : market === "phoenix" ? "AZ" : "TX"} value={field("region")} onChange={change} /><PropertyField name="postal" label={market === "bengaluru" ? "PIN" : "ZIP"} placeholder={market === "bengaluru" ? "560001" : "78701"} numeric value={field("postal")} onChange={change} /></div>
          <div style={{ color: PT.muted, fontSize: "9px", lineHeight: 1.5 }}>ZIP/PIN is enough for market exploration. Exact address is optional for an owned property; US county geography is resolved in the background.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
            <button type="button" onClick={checkAddress} disabled={checkingAddress || !field("address").trim()} style={{ ...buttonStyle, width: "auto", padding: "7px 12px", opacity: checkingAddress || !field("address").trim() ? .45 : 1 }}>{checkingAddress ? "Checking address…" : "Check this address is real"}</button>
            <span style={{ color: PT.muted, fontSize: "9px" }}>Optional. Saving always re-checks.</span>
          </div>
          {addressCheck ? <div role="status" style={{ border: `1px solid ${PT.border}`, borderRadius: "6px", padding: "9px 10px", display: "grid", gap: "4px" }}>
            <strong style={{ color: verificationTone(addressCheck.state), fontSize: "10px" }}>{ADDRESS_VERIFICATION_LABEL[addressCheck.state]}</strong>
            {addressCheck.standardized ? <span style={{ color: PT.textSub, fontSize: "10px" }}>USPS standardized form: {addressCheck.standardized}</span> : null}
            <span style={{ color: PT.textSub, fontSize: "9px", lineHeight: 1.55 }}>{addressCheck.reason}</span>
            {verificationAge(addressCheck) ? <span style={{ color: PT.muted, fontSize: "9px" }}>{verificationAge(addressCheck)}</span> : null}
          </div> : null}
          <div style={{ borderTop: `1px solid ${PT.border}`, paddingTop: "12px", color: PT.text, fontSize: "11px", fontWeight: 700 }}>Monthly carrying cost</div>
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}><PropertyField name="rate" label="Mortgage rate %" placeholder="Statement" numeric value={field("rate")} onChange={change} /><PropertyField name="years" label="Years remaining" placeholder="30" numeric value={field("years")} onChange={change} /><PropertyField name="tax" label={`Annual property tax (${currencyFor(market)})`} placeholder="Tax bill/estimate" numeric value={field("tax")} onChange={change} /><PropertyField name="insurance" label={`Annual insurance (${currencyFor(market)})`} placeholder="Quote/policy" numeric value={field("insurance")} onChange={change} /><PropertyField name="maintenance" label={`Annual maintenance (${currencyFor(market)})`} placeholder="Planning assumption" numeric value={field("maintenance")} onChange={change} /><PropertyField name="hoa" label={`Monthly HOA (${currencyFor(market)})`} placeholder="0" numeric value={field("hoa")} onChange={change} /><PropertyField name="other" label={`Other monthly (${currencyFor(market)})`} placeholder="Utilities/fees" numeric value={field("other")} onChange={change} /></div>
          <button type="button" onClick={saveProperty} disabled={!name.trim()} style={{ ...buttonStyle, opacity: name.trim() ? 1 : .45 }}>{editingId ? "Save and record history" : "Add property"}</button>
          {message ? <div role="alert" style={{ color: PT.amber, fontSize: "10px" }}>{message}</div> : null}
          <LocalOnlyNotice>Private fields are encrypted before database storage. Saving changes updates the current record and appends a separate encrypted value/cost snapshot. Archive hides a record but never erases its history.</LocalOnlyNotice>
        </div>
      </section>
      <section style={{ display: "grid", gap: "18px", minWidth: 0 }}>
        <div style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><Building2 size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Tracked properties</h2></div>
          {items.length === 0 ? <EmptyState title="No property records" detail="Add a property to track its private address, equity, and carrying costs." /> : <div>
            <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1.3fr .8fr .7fr .8fr .8fr .9fr 62px", gap: "10px", padding: "9px 13px", borderBottom: `1px solid ${PT.border}`, color: PT.muted, fontSize: "9px", fontWeight: 800 }}><span>PROPERTY</span><span>MARKET</span><span>USE</span><span>STATUS</span><span>EQUITY</span><span>MONTHLY COST</span><span /></div>
            {items.map((item) => { const equity = item.details.value == null ? null : Math.max(0, item.details.value - numeric(item.details.loan)); const monthlyCost = carryingCost(item.details); const geocodeState = item.details.geocode?.state; const verification = item.details.addressVerification; const postalCode = item.details.geocode?.postalCode ?? item.details.address?.postalCode; return <div key={item.id} style={{ borderBottom: `1px solid ${PT.border}` }}>
              <div className="property-table-row" style={{ display: "grid", gridTemplateColumns: "1.3fr .8fr .7fr .8fr .8fr .9fr 62px", gap: "10px", alignItems: "center", padding: "12px 13px", color: PT.textSub, fontSize: "11px" }}>
              <strong data-label="PROPERTY" style={{ color: PT.text }}>{item.name}<small style={{ display: "block", color: geocodeState === "resolved" ? PT.accent : PT.muted, fontSize: "9px", marginTop: "3px" }}>{postalCode ? `${postalCode} · ` : ""}{geocodeState === "resolved" ? "county geography resolved" : geocodeState ? `county geography ${geocodeState.replace("_", " ")}` : "address not linked"}</small>
              <small title={verification ? `${verification.reason} ${verificationAge(verification)}`.trim() : undefined} style={{ display: "block", color: verificationTone(verification?.state), fontSize: "9px", marginTop: "2px", fontWeight: 400 }}>{verification ? ADDRESS_VERIFICATION_LABEL[verification.state] : "Address never checked — open the property and run the address check."}</small></strong>
              <span data-label="MARKET">{marketLabel(item.market)}</span><span data-label="USE">{item.use}</span><span data-label="STATUS">{item.status}</span><span data-label="EQUITY">{equity == null ? "—" : `${currencyFor(item.market)} ${equity.toLocaleString()}`}</span><span data-label="MONTHLY COST">{monthlyCost == null ? "Incomplete" : `${currencyFor(item.market)} ${monthlyCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span><span style={{ display: "flex", justifyContent: "flex-end", gap: "2px" }}><button type="button" title="Edit property" aria-label={`Edit ${item.name}`} onClick={() => beginEdit(item)} style={{ border: 0, background: "transparent", color: PT.accent, padding: "7px", cursor: "pointer" }}><Pencil size={13} /></button><button type="button" title="Archive property" aria-label={`Archive ${item.name}`} onClick={() => archiveProperty(item.id)} style={{ border: 0, background: "transparent", color: PT.muted, padding: "7px", cursor: "pointer" }}><Archive size={13} /></button></span>
              </div>
              {postalCode ? <div style={{ padding: "0 13px 12px" }}><ZipAreaTrend market={item.market} zip={postalCode} /></div> : null}
            </div>; })}
          </div>}
        </div>
        <div style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden", background: PT.surface }}>
          <div style={{ padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, display: "flex", gap: "12px", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}><div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Owner-recorded history</h2><p style={{ color: PT.muted, fontSize: "10px", margin: "4px 0 0" }}>Value, equity, and monthly carrying cost from immutable encrypted snapshots.</p></div>{items.length ? <select aria-label="Property history" value={historyAssetId} onChange={(event) => setHistoryAssetId(event.target.value)} style={{ ...fieldStyle, width: "auto", minWidth: "150px" }}>{items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> : null}</div>
          {!selectedHistoryAsset ? <EmptyState title="Choose a property" detail="A property history becomes available after its first save." /> : selectedHistory.length === 0 ? <EmptyState title="No history points yet" detail="Open this property, confirm its values, and save once to create the first immutable snapshot." /> : <div style={{ padding: "14px 10px 8px", height: "280px" }}><ResponsiveContainer width="100%" height="100%"><LineChart data={selectedHistory} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}><XAxis dataKey="asOf" tick={{ fill: PT.muted, fontSize: 9 }} tickLine={false} axisLine={{ stroke: PT.border }} /><YAxis yAxisId="value" tick={{ fill: PT.muted, fontSize: 9 }} tickLine={false} axisLine={false} width={54} /><YAxis yAxisId="cost" orientation="right" tick={{ fill: PT.muted, fontSize: 9 }} tickLine={false} axisLine={false} width={54} /><Tooltip contentStyle={{ background: PT.surface, border: `1px solid ${PT.border}`, borderRadius: 6, fontSize: 10 }} formatter={(value: unknown) => { const scalar = Array.isArray(value) ? value[0] : value; return scalar == null ? "—" : `${currencyFor(selectedHistoryAsset.market)} ${Number(scalar).toLocaleString(undefined, { maximumFractionDigits: 0 })}`; }} /><Line yAxisId="value" type="monotone" dataKey="value" name="Value" stroke={PT.accent} strokeWidth={2} dot={{ r: 3 }} connectNulls /><Line yAxisId="value" type="monotone" dataKey="equity" name="Equity" stroke="#8fcf72" strokeWidth={2} dot={{ r: 3 }} connectNulls /><Line yAxisId="cost" type="monotone" dataKey="monthlyCost" name="Monthly cost" stroke={PT.amber} strokeWidth={2} dot={{ r: 3 }} connectNulls /></LineChart></ResponsiveContainer></div>}
        </div>
        <ValueIntelligencePanel assets={items.map((item) => ({ id: item.id, display_label: item.name, geography_slug: item.market }))} />
      </section>
    </div>
  </PropertyPageFrame>;
}
