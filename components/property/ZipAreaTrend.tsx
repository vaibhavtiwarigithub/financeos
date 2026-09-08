"use client";

import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer } from "recharts";
import { PT } from "./PropertyPrimitives";
import type { PropertyMarketId } from "@/lib/property/registry";

type ZipTrendResponse = {
  available: boolean;
  points: { asOf: string; value: number }[];
  sourceVersion: string | null;
  sourceName: string;
  sourceUrl: string;
  error?: string;
};

function pctChange(points: { asOf: string; value: number }[], monthsBack: number): number | null {
  if (points.length < monthsBack + 1) return null;
  const latest = points[points.length - 1].value;
  const prior = points[points.length - 1 - monthsBack].value;
  if (!prior) return null;
  return ((latest - prior) / prior) * 100;
}

/**
 * ZIP-level Zillow ZHVI area context, rendered strictly beside — never
 * inside — the owner's own recorded property value. WHY: ZHVI is a
 * weighted average of the middle third of homes in the ZIP (Zillow's ZHVI
 * User Guide), so it can say what the surrounding area is doing but cannot
 * say what this specific property is worth. NEXT: use it to sanity-check
 * the direction of your own value entry, not to replace it.
 */
export default function ZipAreaTrend({ market, zip }: { market: PropertyMarketId; zip: string | undefined }) {
  const [data, setData] = useState<ZipTrendResponse | null>(null);
  const validZip = !!zip && /^\d{5}$/.test(zip) && market !== "bengaluru";

  useEffect(() => {
    if (!validZip) { setData(null); return; }
    let cancelled = false;
    fetch(`/api/property/zip-trend?market=${market}&zip=${zip}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => { if (!cancelled) setData(json); })
      .catch(() => { if (!cancelled) setData({ available: false, points: [], sourceVersion: null, sourceName: "Zillow Research ZHVI (ZIP)", sourceUrl: "https://www.zillow.com/research/data/", error: "Area context could not be loaded" }); });
    return () => { cancelled = true; };
  }, [market, zip, validZip]);

  if (!validZip) return null;
  if (!data) return null;
  if (data.error || !data.available) {
    return <div style={{ marginTop: "8px", padding: "9px 10px", border: `1px dashed ${PT.border}`, borderRadius: "6px", color: PT.muted, fontSize: "9px", lineHeight: 1.5 }}>
      No Zillow ZHVI area data yet for {zip}. WHY: the weekly collector hasn&apos;t written this ZIP, or it falls outside the tracked Austin/Phoenix metro boundary. NEXT: check back after the next weekly run.
    </div>;
  }

  const latest = data.points[data.points.length - 1];
  const change3m = pctChange(data.points, 3);
  const change12m = pctChange(data.points, 12);
  const fmtPct = (v: number | null) => v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const toneFor = (v: number | null) => v == null ? PT.muted : v > 0 ? PT.accent : v < 0 ? PT.red : PT.textSub;

  return (
    <div style={{ marginTop: "8px", padding: "10px 11px", border: `1px solid ${PT.border}`, borderRadius: "6px", background: PT.card }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px", flexWrap: "wrap" }}>
        <div style={{ color: PT.muted, fontSize: "9px", fontWeight: 800, letterSpacing: "0.06em" }}>AREA CONTEXT · ZIP {zip} · ZHVI</div>
        <a href={data.sourceUrl} target="_blank" rel="noreferrer" style={{ color: PT.blue, fontSize: "9px", textDecoration: "none" }}>{data.sourceName}</a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "14px", marginTop: "6px", flexWrap: "wrap" }}>
        <div>
          <div style={{ color: PT.text, fontSize: "16px", fontWeight: 750 }}>${latest.value.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
          <div style={{ color: PT.muted, fontSize: "9px" }}>as of {latest.asOf}</div>
        </div>
        <div style={{ display: "flex", gap: "12px" }}>
          <div><div style={{ color: PT.muted, fontSize: "8px", fontWeight: 700 }}>3M</div><div style={{ color: toneFor(change3m), fontSize: "11px", fontWeight: 700 }}>{fmtPct(change3m)}</div></div>
          <div><div style={{ color: PT.muted, fontSize: "8px", fontWeight: 700 }}>12M</div><div style={{ color: toneFor(change12m), fontSize: "11px", fontWeight: 700 }}>{fmtPct(change12m)}</div></div>
        </div>
        {data.points.length > 1 ? <div style={{ flex: "1 1 90px", minWidth: "70px", height: "28px" }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data.points}><Line type="monotone" dataKey="value" stroke={PT.blue} strokeWidth={1.5} dot={false} isAnimationActive={false} /></LineChart>
          </ResponsiveContainer>
        </div> : null}
      </div>
      <div style={{ color: PT.muted, fontSize: "8.5px", lineHeight: 1.5, marginTop: "6px" }}>
        WHY it&apos;s separate: ZHVI is Zillow&apos;s ZIP-wide index of the middle third of homes — it describes the area, not this property. It is never blended into or used to infer your own recorded value above. NEXT: use the 3M/12M direction as area context only.
      </div>
    </div>
  );
}
