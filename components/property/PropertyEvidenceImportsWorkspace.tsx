"use client";

import { useEffect, useState } from "react";
import { FileText, LockKeyhole, ShieldCheck } from "lucide-react";
import { PROPERTY_IMPORT_TYPES, type PropertyEvidenceImportType } from "@/lib/property/import-contract";
import { PROPERTY_MARKETS } from "@/lib/property/registry";
import { usePropertyMarket } from "@/lib/property/market-context";
import { EmptyState, FieldLabel, LocalOnlyNotice, PT, PropertyPageFrame, buttonStyle, fieldStyle } from "@/components/property/PropertyPrimitives";

type EvidenceRecord = { id: string; geography_slug: string | null; import_type: PropertyEvidenceImportType; source_label: string; as_of: string | null; created_at: string };

const typeLabel: Record<PropertyEvidenceImportType, string> = { tax_notice: "Property tax notice", insurance_quote: "Insurance quote or policy" };

export default function PropertyEvidenceImportsWorkspace() {
  const { market } = usePropertyMarket();
  const [records, setRecords] = useState<EvidenceRecord[]>([]);
  const [encryptionReady, setEncryptionReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [importType, setImportType] = useState<PropertyEvidenceImportType>("tax_notice");
  const [sourceLabel, setSourceLabel] = useState("");
  const [asOf, setAsOf] = useState("");
  const [content, setContent] = useState("");

  async function load() {
    setLoading(true);
    try {
      const response = await fetch("/api/property/owner-evidence", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Evidence records could not be read");
      setRecords(data.records ?? []); setEncryptionReady(Boolean(data.encryptionReady));
    } catch (error) { setMessage(error instanceof Error ? error.message : "Evidence records could not be read"); }
    finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setMessage(null); setSaving(true);
    try {
      const response = await fetch("/api/property/owner-evidence", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ importType, sourceLabel, asOf: asOf || null, content, market }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Evidence could not be saved");
      setSourceLabel(""); setAsOf(""); setContent("");
      setMessage(data.duplicate ? "The same evidence was already stored." : "Evidence stored securely. It has not been extracted or used as a cost value.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Evidence could not be saved"); }
    finally { setSaving(false); }
  }

  return <PropertyPageFrame eyebrow="Private evidence" title="Tax and insurance evidence" description="Keep an official tax notice or an insurance quote/policy with the property workspace. These records support your own review; Kairos does not extract values or treat a document as an automatic quote." help={{ whatItDoes: "Keeps tax notices and insurance quotes or policies encrypted alongside your property record. The app lists only safe metadata and does not automatically extract a bill or premium.", whatToLookFor: ["Use the source label and date so you can recognize the document later.", "Do not paste account, government-ID, or payment-card numbers.", "A stored document is evidence for your review, not a live quote or tax lookup."] }}>
    <div className="property-page-body" style={{ padding: "24px 28px", maxWidth: "1040px", display: "grid", gap: "18px" }}>
      <LocalOnlyNotice><LockKeyhole size={13} style={{ verticalAlign: "-2px", marginRight: "5px" }} />Text is AES-256-GCM encrypted before storage. Only the document label, type, date, and selected market are listed below. Do not include bank-account or government-ID numbers.</LocalOnlyNotice>
      {!encryptionReady ? <div style={{ padding: "12px", border: `1px solid ${PT.amber}`, borderRadius: "6px", color: PT.amber, fontSize: "11px" }}>Private evidence storage is locked until <code>PROPERTY_DATA_ENCRYPTION_KEY</code> is configured.</div> : null}
      <form onSubmit={submit} style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.card, padding: "18px", display: "grid", gap: "14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}><ShieldCheck size={17} color={PT.accent} /><strong style={{ fontSize: "13px" }}>Add owner-provided evidence</strong></div>
        <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "12px" }}>
          <FieldLabel label="Evidence type"><select value={importType} onChange={(event) => setImportType(event.target.value as PropertyEvidenceImportType)} style={fieldStyle}>{PROPERTY_IMPORT_TYPES.map((type) => <option key={type} value={type}>{typeLabel[type]}</option>)}</select></FieldLabel>
          <FieldLabel label="Market"><select value={market} disabled style={{ ...fieldStyle, color: PT.textSub, opacity: .8 }}>{PROPERTY_MARKETS.map((item) => <option key={item.id} value={item.id}>{item.country} - {item.label}</option>)}</select></FieldLabel>
          <FieldLabel label="Source label" hint="Example: Travis County 2026 tax notice"><input required maxLength={120} value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} style={fieldStyle} /></FieldLabel>
          <FieldLabel label="Document or quote date" hint="Optional. Use the date shown on the notice or quote."><input type="date" value={asOf} onChange={(event) => setAsOf(event.target.value)} style={fieldStyle} /></FieldLabel>
        </div>
        <FieldLabel label="Notice or quote text" hint="Paste up to 1 MB. This release does not accept files and never performs OCR, parsing, quote comparison, or automatic cost extraction."><textarea required value={content} onChange={(event) => setContent(event.target.value)} maxLength={1_000_000} rows={10} style={{ ...fieldStyle, resize: "vertical", lineHeight: 1.45 }} /></FieldLabel>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}><span style={{ color: PT.muted, fontSize: "10px" }}>{content.length.toLocaleString()} / 1,000,000 characters</span><button type="submit" disabled={saving || !encryptionReady} style={{ ...buttonStyle, opacity: saving || !encryptionReady ? .65 : 1 }}>{saving ? "Encrypting..." : "Store evidence"}</button></div>
      </form>
      {message ? <div role="status" style={{ color: message.includes("securely") || message.includes("already") ? PT.accent : PT.amber, fontSize: "11px" }}>{message}</div> : null}
      <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden", background: PT.card }}>
        <div style={{ padding: "14px 16px", borderBottom: `1px solid ${PT.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px" }}><div><strong style={{ fontSize: "13px" }}>Stored evidence</strong><div style={{ color: PT.muted, fontSize: "10px", marginTop: "3px" }}>Metadata only. Encrypted text is not rendered back into the browser.</div></div><FileText size={16} color={PT.muted} /></div>
        {loading ? <EmptyState title="Loading evidence" detail="Reading private evidence metadata." /> : records.length === 0 ? <EmptyState title="No tax or insurance evidence stored" detail="Paste an official notice or quote when you want it retained beside your property decisions." /> : <div>{records.map((record) => <div className="property-table-row" key={record.id} style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr .7fr .7fr", gap: "12px", padding: "13px 16px", borderBottom: `1px solid ${PT.border}`, fontSize: "11px" }}><span data-label="TYPE" style={{ color: PT.text }}>{typeLabel[record.import_type]}</span><span data-label="SOURCE" style={{ color: PT.textSub }}>{record.source_label}</span><span data-label="MARKET" style={{ color: PT.textSub }}>{PROPERTY_MARKETS.find((item) => item.id === record.geography_slug)?.label ?? "Not specified"}</span><span data-label="DATE" style={{ color: PT.muted }}>{record.as_of ?? new Date(record.created_at).toLocaleDateString()}</span></div>)}</div>}
      </section>
    </div>
  </PropertyPageFrame>;
}
