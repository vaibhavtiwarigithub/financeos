"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Plus, Trash2 } from "lucide-react";
import { buttonStyle, EmptyState, fieldStyle, FieldLabel, LocalOnlyNotice, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";

type PropertyDraft = {
  id: string;
  name: string;
  market: "Austin" | "Phoenix" | "Bengaluru";
  use: "Home" | "Rental" | "Land";
  status: "Owned" | "Watching";
  value?: number;
  loan?: number;
};

const currencyFor = (market: PropertyDraft["market"]) => market === "Bengaluru" ? "INR" : "USD";

export default function MyPropertiesWorkspace() {
  const [items, setItems] = useState<PropertyDraft[]>([]);
  const [name, setName] = useState("");
  const [market, setMarket] = useState<PropertyDraft["market"]>("Austin");
  const [use, setUse] = useState<PropertyDraft["use"]>("Home");
  const [status, setStatus] = useState<PropertyDraft["status"]>("Owned");
  const [value, setValue] = useState("");
  const [loan, setLoan] = useState("");
  const [encryptionReady, setEncryptionReady] = useState<boolean | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    fetch("/api/property/assets").then(response => response.json()).then(payload => {
      setEncryptionReady(Boolean(payload.encryptionReady));
      setItems((payload.assets ?? []).map((row: any) => ({ id: row.id, name: row.display_label, market: row.geography_slug === "bengaluru" ? "Bengaluru" : row.geography_slug === "phoenix" ? "Phoenix" : "Austin", use: row.asset_type === "rental" ? "Rental" : row.asset_type === "land" ? "Land" : "Home", status: row.details?.status === "Watching" ? "Watching" : "Owned", value: row.details?.value, loan: row.details?.loan })));
    }).catch(() => setEncryptionReady(false));
  }, []);

  const owned = useMemo(() => items.filter((item) => item.status === "Owned"), [items]);
  const knownEquity = useMemo(() => owned.reduce((sum, item) => sum + Math.max(0, (item.value ?? 0) - (item.loan ?? 0)), 0), [owned]);
  const mixedCurrencies = new Set(owned.map((item) => currencyFor(item.market))).size > 1;

  async function addProperty() {
    if (!name.trim()) return;
    setMessage("");
    const response = await fetch("/api/property/assets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ displayLabel: name.trim(), market: market.toLowerCase(), assetType: use.toLowerCase(), details: { status, value: value ? Number(value) : undefined, loan: loan ? Number(loan) : undefined } }) });
    const payload = await response.json();
    if (!response.ok) { setMessage(payload.error ?? "Property could not be saved"); return; }
    setItems((current) => [...current, { id: payload.id, name: name.trim(), market, use, status, value: value ? Number(value) : undefined, loan: loan ? Number(loan) : undefined }]);
    setName(""); setValue(""); setLoan("");
  }

  async function removeProperty(id: string) {
    const response = await fetch(`/api/property/assets?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) setItems(current => current.filter(entry => entry.id !== id));
  }

  return (
    <PropertyPageFrame eyebrow="Private workspace" title="My properties" description="Organize owned and watched properties without mixing currencies or turning estimates into verified valuations.">
      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="OWNED" value={String(owned.length)} />
        <StatCell label="WATCHING" value={String(items.length - owned.length)} />
        <StatCell label="KNOWN EQUITY" value={mixedCurrencies ? "Split by market" : owned.length ? knownEquity.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—"} detail={mixedCurrencies ? "USD and INR are never summed" : owned[0] ? currencyFor(owned[0].market) : "No values entered"} />
        <StatCell label="STORAGE" value={encryptionReady ? "Encrypted" : encryptionReady === null ? "Checking" : "Locked"} tone={encryptionReady ? PT.accent : PT.amber} detail={encryptionReady ? "AES-256-GCM, owner-only" : "Server encryption key required"} />
      </div>
      <div className="property-page-body property-two-column" style={{ padding: "22px 28px", display: "grid", gridTemplateColumns: "minmax(280px, 360px) minmax(0, 1fr)", gap: "18px", alignItems: "start" }}>
        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "16px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", marginBottom: "14px" }}><Plus size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Add a workspace record</h2></div>
          <div style={{ display: "grid", gap: "12px" }}>
            <FieldLabel label="Nickname"><input aria-label="Property nickname" value={name} onChange={(event) => setName(event.target.value)} placeholder="Example: Austin home" style={fieldStyle} /></FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label="Market"><select value={market} onChange={(event) => setMarket(event.target.value as PropertyDraft["market"])} style={fieldStyle}><option>Austin</option><option>Phoenix</option><option>Bengaluru</option></select></FieldLabel>
              <FieldLabel label="Use"><select value={use} onChange={(event) => setUse(event.target.value as PropertyDraft["use"])} style={fieldStyle}><option>Home</option><option>Rental</option><option>Land</option></select></FieldLabel>
            </div>
            <FieldLabel label="Status"><select value={status} onChange={(event) => setStatus(event.target.value as PropertyDraft["status"])} style={fieldStyle}><option>Owned</option><option>Watching</option></select></FieldLabel>
            <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
              <FieldLabel label={`Your value (${currencyFor(market)})`}><input aria-label="User-entered property value" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} placeholder="Optional" style={fieldStyle} /></FieldLabel>
              <FieldLabel label={`Loan balance (${currencyFor(market)})`}><input aria-label="User-entered loan balance" inputMode="decimal" value={loan} onChange={(event) => setLoan(event.target.value)} placeholder="Optional" style={fieldStyle} /></FieldLabel>
            </div>
            <button type="button" onClick={addProperty} disabled={!name.trim()} style={{ ...buttonStyle, opacity: name.trim() ? 1 : 0.45 }}>Add record</button>
            {message ? <div style={{ color: PT.amber, fontSize: "10px" }}>{message}</div> : null}
            <LocalOnlyNotice>Private fields are encrypted before database storage and never sent to an LLM. This form intentionally uses a nickname rather than a street address.</LocalOnlyNotice>
          </div>
        </section>
        <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "13px 15px", borderBottom: `1px solid ${PT.border}`, background: PT.surface }}><Building2 size={15} color={PT.accent} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Workspace records</h2></div>
          {items.length === 0 ? <EmptyState title="No property records" detail="Add a nickname and market to begin a temporary comparison. Private persistence remains disabled until the vault is available." /> : (
            <div>
              <div className="property-table-header" style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr .7fr .8fr .8fr 28px", gap: "10px", padding: "9px 13px", borderBottom: `1px solid ${PT.border}`, color: PT.muted, fontSize: "9px", fontWeight: 800 }}><span>PROPERTY</span><span>MARKET</span><span>USE</span><span>STATUS</span><span>EQUITY</span><span /></div>
              {items.map((item) => {
                const equity = item.value == null ? null : Math.max(0, item.value - (item.loan ?? 0));
                return <div className="property-table-row" key={item.id} style={{ display: "grid", gridTemplateColumns: "1.4fr .8fr .7fr .8fr .8fr 28px", gap: "10px", alignItems: "center", padding: "12px 13px", borderBottom: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "11px" }}>
                  <strong style={{ color: PT.text }}>{item.name}</strong><span>{item.market}</span><span>{item.use}</span><span>{item.status}</span><span>{equity == null ? "—" : `${currencyFor(item.market)} ${equity.toLocaleString()}`}</span><button type="button" title="Remove record" aria-label={`Remove ${item.name}`} onClick={() => removeProperty(item.id)} style={{ border: 0, background: "transparent", color: PT.muted, padding: "4px", cursor: "pointer" }}><Trash2 size={14} /></button>
                </div>;
              })}
            </div>
          )}
        </section>
      </div>
    </PropertyPageFrame>
  );
}
