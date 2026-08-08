"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, BadgeDollarSign, Building2, Database, ExternalLink, RefreshCw, Scale, ShieldAlert, X } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PropertyValuationStageOneResponse, ValuationSourceCoverage } from "@/lib/property/valuation-contract";
import { EmptyState, PropertyPageFrame, PT, StatCell } from "./PropertyPrimitives";
import { usePropertyMarket } from "@/lib/property/market-context";
import { PROPERTY_CHART_WINDOWS, propertyWindowCutoff, type PropertyChartWindowId } from "@/lib/property/chart-windows";

const STATUS_LABEL: Record<ValuationSourceCoverage["state"], string> = {
  available: "Evidence available",
  no_rows: "Connected; no rows",
  inactive: "Source inactive",
  not_connected: "Not connected",
  error: "Source error",
};

const STATUS_COLOR: Record<ValuationSourceCoverage["state"], string> = {
  available: PT.accent,
  no_rows: PT.amber,
  inactive: PT.amber,
  not_connected: PT.muted,
  error: PT.red,
};

function CoveragePanel({ title, description, coverage }: { title: string; description: string; coverage: ValuationSourceCoverage }) {
  const color = STATUS_COLOR[coverage.state];
  return (
    <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", overflow: "hidden", background: PT.surface }}>
      <div style={{ padding: "14px 16px", borderBottom: `1px solid ${PT.border}`, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>{title}</h2><p style={{ color: PT.textSub, fontSize: "10px", lineHeight: 1.5, margin: "5px 0 0" }}>{description}</p></div>
        <span style={{ flexShrink: 0, color, border: `1px solid ${color}55`, background: `${color}0F`, borderRadius: "999px", padding: "4px 7px", fontSize: "9px", fontWeight: 800 }}>{STATUS_LABEL[coverage.state]}</span>
      </div>
      <div className="property-coverage-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div style={{ padding: "13px 15px", borderRight: `1px solid ${PT.border}` }}><div style={{ color: PT.muted, fontSize: "9px", fontWeight: 700 }}>COVERAGE ROWS</div><div style={{ color: PT.text, fontSize: "14px", fontWeight: 700, marginTop: "5px" }}>{coverage.rowCount == null ? "Not measured" : coverage.rowCount.toLocaleString()}</div></div>
        <div style={{ padding: "13px 15px", borderRight: `1px solid ${PT.border}` }}><div style={{ color: PT.muted, fontSize: "9px", fontWeight: 700 }}>LATEST RUN</div><div style={{ color: PT.text, fontSize: "11px", fontWeight: 650, marginTop: "5px" }}>{coverage.latestRun ? coverage.latestRun.outcome : "No run"}</div></div>
        <div style={{ padding: "13px 15px" }}><div style={{ color: PT.muted, fontSize: "9px", fontWeight: 700 }}>ROWS WRITTEN IN RUN</div><div style={{ color: PT.text, fontSize: "11px", fontWeight: 650, marginTop: "5px" }}>{coverage.latestRun?.rowsWritten == null ? "—" : coverage.latestRun.rowsWritten.toLocaleString()}</div></div>
      </div>
      <div style={{ padding: "10px 15px", borderTop: `1px solid ${PT.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", color: PT.muted, fontSize: "9px" }}>
        <span>{coverage.latestRun ? `Run ${new Date(coverage.latestRun.startedAt).toLocaleString()}` : "No ingestion evidence has been recorded."}</span>
        <a href={coverage.officialUrl} target="_blank" rel="noreferrer" style={{ display: "inline-flex", gap: "4px", alignItems: "center", color: PT.blue, textDecoration: "none", whiteSpace: "nowrap" }}>{coverage.sourceName}<ExternalLink size={10} /></a>
      </div>
    </section>
  );
}

export default function PropertyValuationStageOne() {
  const { market } = usePropertyMarket();
  const [payload, setPayload] = useState<PropertyValuationStageOneResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<PropertyChartWindowId>("5y");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/property/valuation-evidence", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Evidence request failed (HTTP ${response.status})`);
      setPayload(body as PropertyValuationStageOneResponse);
      setError(null);
    } catch (reason) {
      setPayload(null);
      setError(reason instanceof Error ? reason.message : "Valuation evidence unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const trendRows = payload?.austin.metroTrend.rows ?? [];
  const latestTrend = trendRows.at(-1) ?? null;
  const latestAssessment = payload?.austin.assessedValueRows.at(-1) ?? null;
  const phoenixReady = payload?.phoenix.sales.state === "available";
  const chartRows = useMemo(() => {
    const cutoff = propertyWindowCutoff(windowId);
    return trendRows.filter((row) => !cutoff || row.asOf >= cutoff).map((row) => ({ date: row.asOf, value: row.value }));
  }, [trendRows, windowId]);

  const disableScope = async (id: string) => {
    const response = await fetch(`/api/property/valuation-evidence?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) await load();
  };

  return (
    <PropertyPageFrame eyebrow="Stage 1 evidence" title="Valuation evidence" description="Source coverage and tax-assessment references only. Kairos does not calculate an automated valuation, parcel value range, or market price in this stage." help={{ whatItDoes: "Shows the exact source coverage behind possible future valuation work. It preserves evidence boundaries and makes unavailable county data explicit.", whatToLookFor: ["County assessment is a tax-system reference, never a current market price.", "A contract-pending source cannot collect data or create a valuation scope.", "No AVM, sale comparable, or parcel range is active on this page."] }} action={<button type="button" onClick={() => void load()} disabled={loading} style={{ minHeight: "34px", display: "inline-flex", alignItems: "center", gap: "6px", padding: "7px 10px", borderRadius: "6px", border: `1px solid ${PT.border}`, background: PT.surface, color: PT.textSub, fontSize: "10px", cursor: loading ? "default" : "pointer" }}><RefreshCw size={13} />Refresh evidence</button>}>
      <div style={{ display: "flex", gap: "7px", alignItems: "center", flexWrap: "wrap", padding: "11px 28px", borderBottom: `1px solid ${PT.border}`, background: `${PT.red}08` }}>
        <ShieldAlert size={14} color={PT.red} />
        {[
          "NO AVM",
          "NO MARKET-PRICE ESTIMATE",
          "NO PARCEL VALUE RANGE",
        ].map((label) => <span key={label} style={{ color: PT.red, border: `1px solid ${PT.red}55`, borderRadius: "999px", padding: "4px 7px", fontSize: "9px", fontWeight: 850 }}>{label}</span>)}
        <span style={{ color: PT.textSub, fontSize: "10px" }}>A county assessment is a tax reference, not a sale-price opinion.</span>
      </div>

      <div className="property-stat-row" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", borderBottom: `1px solid ${PT.border}` }}>
        <StatCell label="PHOENIX EVIDENCE" value={loading ? "Checking" : phoenixReady ? "Available" : "Incomplete"} tone={phoenixReady ? PT.accent : PT.amber} />
        <StatCell label="AUSTIN TCAD REFERENCE" value={latestAssessment ? "Available" : "No row"} tone={latestAssessment ? PT.accent : PT.muted} />
        <StatCell label="AUSTIN FHFA TREND" value={trendRows.length ? `${trendRows.length} rows` : "No rows"} />
        <StatCell label="VALUATION CLAIM" value="Disabled" tone={PT.red} />
      </div>

      <div className="property-page-body" style={{ padding: "20px 28px" }}>
        {market === "phoenix" ? <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "14px", marginBottom: "15px" }}>
          <div style={{ color: PT.amber, fontSize: "11px", fontWeight: 700 }}>Phoenix collection is disabled pending source licence verification.</div>
          <div style={{ marginTop: "7px", color: PT.muted, fontSize: "9px", lineHeight: 1.5 }}>Kairos retains historical evidence but will not accept a new ZIP, download a county archive, or represent the feed as free until a documented machine-use contract is reviewed.</div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "10px" }}>
            {(payload?.scopes ?? []).filter((scope) => scope.market === market && scope.active).map((scope) => <span key={scope.id} style={{ display: "inline-flex", alignItems: "center", gap: "5px", border: `1px solid ${PT.border}`, borderRadius: "999px", color: PT.textSub, padding: "4px 7px", fontSize: "9px" }}>{scope.label}<button type="button" aria-label={`Disable ${scope.label}`} onClick={() => void disableScope(scope.id)} style={{ border: 0, background: "transparent", color: PT.muted, display: "inline-flex", padding: 0, cursor: "pointer" }}><X size={10} /></button></span>)}
            {!(payload?.scopes ?? []).some((scope) => scope.market === market && scope.active) && <span style={{ color: PT.muted, fontSize: "9px" }}>No active collection scope. The bulk worker will skip the download.</span>}
          </div>
        </section> : market === "austin" ? <div style={{ marginBottom: "15px", padding: "13px 15px", border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, color: PT.textSub, fontSize: "10px", lineHeight: 1.6 }}>Add a specific Austin address under My Properties. Kairos resolves geography in the background; county parcel IDs are not an owner-facing input. TCAD assessment linkage remains unavailable until the address-to-parcel resolver is source-verified.</div> : <div style={{ marginBottom: "15px" }}><EmptyState title="Bengaluru parcel evidence is not connected" detail="Use a PIN/locality for market exploration. Kairos will not request a US county identifier or fabricate parcel-level tax or valuation data for India." /></div>}

        {error ? <div role="alert" style={{ border: `1px solid ${PT.red}`, borderRadius: "7px", padding: "16px", color: PT.red, display: "flex", gap: "8px", alignItems: "center", fontSize: "11px" }}><AlertTriangle size={15} />{error}. This is a coverage-check failure, not evidence of zero records.</div> : loading ? <div style={{ color: PT.muted, padding: "54px 0", fontSize: "11px" }}>Checking source coverage...</div> : !payload || market === "bengaluru" ? null : market === "phoenix" ? (
          <div style={{ display: "grid", gap: "15px" }}>
            <CoveragePanel title="Recorded transfer evidence" description="Maricopa deed-linked sales-affidavit observations for selected ZIPs. Corrections remain separate snapshot observations; recorded prices are not a Kairos valuation for a home." coverage={payload.phoenix.sales} />
            <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, padding: "17px", display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", gap: "12px" }}>
              <Database size={18} color={PT.blue} />
              <div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>What Phoenix Stage 1 can say</h2><p style={{ color: PT.textSub, fontSize: "10px", lineHeight: 1.6, margin: "6px 0 0" }}>{phoenixReady ? "Selected-scope transfer evidence is available. This confirms evidence coverage only; no repeat-sales model, comparable analysis, interpolation, or value range is enabled." : "No selected-scope transfer evidence is available yet. Kairos cannot infer comparable sales or a parcel value from this state."}</p></div>
            </section>
          </div>
        ) : (
          <div className="property-two-column" style={{ display: "grid", gridTemplateColumns: "minmax(290px, .85fr) minmax(0, 1.4fr)", gap: "15px", alignItems: "stretch" }}>
            <section style={{ border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${PT.border}`, display: "flex", alignItems: "center", gap: "8px" }}><BadgeDollarSign size={16} color={PT.amber} /><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>TCAD assessed-value reference</h2></div>
              {latestAssessment ? <div style={{ padding: "20px 16px" }}><div style={{ color: PT.muted, fontSize: "9px", fontWeight: 800 }}>COUNTY APPRAISAL DISTRICT ESTIMATE</div><div style={{ color: PT.text, fontSize: "26px", fontWeight: 760, marginTop: "6px" }}>{latestAssessment.assessedValue.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}</div><div style={{ color: PT.textSub, fontSize: "10px", marginTop: "6px" }}>Tax year {latestAssessment.taxYear} · parcel reference {latestAssessment.parcelRef}</div></div> : <EmptyState title="No TCAD assessment row connected" detail="No assessed value is shown because the Stage-1 API has no source-backed parcel reference. Kairos will not substitute a listing estimate or placeholder." />}
              <div style={{ padding: "12px 16px", borderTop: `1px solid ${PT.border}`, background: `${PT.amber}09`, color: PT.amber, fontSize: "10px", lineHeight: 1.55 }}><strong>Not a market price.</strong> Texas does not publish sale prices. This is the county appraisal district’s estimate for tax purposes, not an AVM, appraisal, comparable sale, or expected sale price.</div>
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${PT.border}`, color: PT.muted, fontSize: "9px", display: "flex", justifyContent: "space-between", gap: "8px" }}><span>{STATUS_LABEL[payload.austin.assessment.state]}</span><a href={payload.austin.assessment.officialUrl} target="_blank" rel="noreferrer" style={{ color: PT.blue, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: "4px" }}>TCAD source<ExternalLink size={10} /></a></div>
            </section>
            <section style={{ minWidth: 0, border: `1px solid ${PT.border}`, borderRadius: "7px", background: PT.surface, overflow: "hidden" }}>
              <div style={{ padding: "14px 16px", borderBottom: `1px solid ${PT.border}`, display: "flex", justifyContent: "space-between", gap: "10px" }}><div><h2 style={{ color: PT.text, fontSize: "13px", margin: 0 }}>Austin metro price trend</h2><div style={{ color: PT.muted, fontSize: "9px", marginTop: "4px" }}>{latestTrend ? `FHFA HPI · ${latestTrend.nativeUnit} · as of ${latestTrend.asOf} · ${latestTrend.revisionState}` : "FHFA HPI · no observations returned"}</div></div><Building2 size={16} color={PT.accent} /></div>
              <div style={{ display: "flex", gap: "5px", flexWrap: "wrap", padding: "9px 16px 0" }}>{PROPERTY_CHART_WINDOWS.map((item) => <button key={item.id} type="button" onClick={() => setWindowId(item.id)} style={{ minHeight: "27px", padding: "4px 8px", border: `1px solid ${windowId === item.id ? PT.accent : PT.border}`, borderRadius: "5px", background: "transparent", color: windowId === item.id ? PT.accent : PT.muted, fontSize: "9px", cursor: "pointer" }}>{item.label}</button>)}</div>
              <div style={{ height: "290px", padding: "14px 10px 8px" }}>{chartRows.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={chartRows} margin={{ top: 8, right: 14, left: 0, bottom: 8 }}><CartesianGrid stroke={PT.border} vertical={false} /><XAxis dataKey="date" tick={{ fill: PT.muted, fontSize: 9 }} minTickGap={35} /><YAxis tick={{ fill: PT.muted, fontSize: 9 }} domain={["auto", "auto"]} /><Tooltip contentStyle={{ background: PT.cardRaised, border: `1px solid ${PT.border}`, borderRadius: "6px", fontSize: "10px" }} /><Line type="monotone" dataKey="value" name="Observed FHFA HPI" stroke={PT.accent} strokeWidth={2} dot={false} isAnimationActive={false} /></LineChart></ResponsiveContainer> : <EmptyState title="No Austin FHFA observations in this range" detail="Choose a longer range or wait for official observations. A metro trend cannot be converted into a parcel price." />}</div>
              <div style={{ padding: "10px 16px", borderTop: `1px solid ${PT.border}`, color: PT.textSub, fontSize: "9px", lineHeight: 1.5 }}><Scale size={12} color={PT.blue} style={{ verticalAlign: "middle", marginRight: "5px" }} />Metro-level repeat-sales context only. It does not estimate the market value of a specific Austin property.</div>
            </section>
          </div>
        )}
      </div>
      <style>{`@media (max-width: 720px) { .property-coverage-grid { grid-template-columns: minmax(0, 1fr) !important; } .property-coverage-grid > div { border-right: 0 !important; border-bottom: 1px solid ${PT.border}; } }`}</style>
    </PropertyPageFrame>
  );
}
