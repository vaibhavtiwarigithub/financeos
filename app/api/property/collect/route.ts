import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { ACTIVE_PROPERTY_ADAPTERS, beginPropertyCollectionRun, propertyRunFetchCount } from "@/lib/property/sources";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) { const gate = await requireOwner(); if (gate) return gate; }
  const requested = new URL(req.url).searchParams.get("market");
  const markets = requested && PROPERTY_MARKETS.some(m => m.id === requested) ? [requested as PropertyMarketId] : PROPERTY_MARKETS.map(m => m.id);
  const svc = createServiceClient();
  // One bounded fetch per distinct upstream payload for the whole run. Without
  // this, the national FHFA and FRED files were re-downloaded once per market.
  beginPropertyCollectionRun();
  const { data: sourceRows } = await svc.from("property_sources").select("source_key, activation_state");
  const active = new Set((sourceRows ?? []).filter((row: any) => row.activation_state === "active").map((row: any) => row.source_key));
  const results: Array<Record<string, unknown>> = [];

  for (const market of markets) for (const adapter of ACTIVE_PROPERTY_ADAPTERS) {
    if (!active.has(adapter.sourceKey)) { results.push({ market, source: adapter.sourceKey, outcome: "skipped", reason: "source_not_active" }); continue; }
    // A source that structurally cannot cover this market is NOT a success with
    // zero rows. Reporting it as success made Bengaluru's real coverage gap look
    // like a quiet day, which the market-local honesty rule forbids. Recorded as
    // a run row too, so the Data Sources view can state the gap rather than
    // showing nothing at all.
    if (!adapter.supportsMarket(market)) {
      const at = new Date().toISOString();
      await svc.from("property_source_runs").insert({ source_key: adapter.sourceKey, geography_slug: market, started_at: at, completed_at: at, outcome: "not_applicable", rows_written: 0, request_count: 0, detail: `${adapter.sourceKey} does not publish data for ${market}` });
      results.push({ market, source: adapter.sourceKey, outcome: "not_applicable", reason: "source_does_not_cover_market" });
      continue;
    }
    const startedAt = new Date().toISOString();
    // Count only requests that actually left the process. With the run cache,
    // a second market reusing the national FHFA/FRED payload makes ZERO network
    // calls, and recording 1 would overstate provider usage in the very ledger
    // used to justify the cadence.
    const fetchesBefore = propertyRunFetchCount();
    const { data: latest } = await svc.from("property_market_observations").select("as_of").eq("source_key", adapter.sourceKey).eq("geography_slug", market).order("as_of", { ascending: false }).limit(1).maybeSingle();
    try {
      const observations = await adapter.fetch({ market, since: latest?.as_of ?? null });
      let written = 0;
      if (observations.length) {
        const payload = observations.map(item => ({ source_key: item.sourceKey, geography_slug: item.market, metric_key: item.metric, native_unit: item.nativeUnit, value: item.value, as_of: item.asOf, published_at: item.publishedAt, source_version: item.sourceVersion, revision_state: item.revisionState }));
        const { data, error } = await svc.from("property_market_observations").upsert(payload, { onConflict: "source_key,geography_slug,metric_key,as_of,revision_state,source_version", ignoreDuplicates: true }).select("id");
        if (error) throw error; written = data?.length ?? 0;
      }
      await svc.from("property_source_runs").insert({ source_key: adapter.sourceKey, geography_slug: market, started_at: startedAt, completed_at: new Date().toISOString(), outcome: "success", rows_written: written, request_count: propertyRunFetchCount() - fetchesBefore });
      results.push({ market, source: adapter.sourceKey, outcome: "success", rowsWritten: written });
    } catch (error) {
      const code = error instanceof Error ? error.name : "collection_error";
      await svc.from("property_source_runs").insert({ source_key: adapter.sourceKey, geography_slug: market, started_at: startedAt, completed_at: new Date().toISOString(), outcome: "failed", error_code: code, detail: error instanceof Error ? error.message.slice(0, 300) : "Unknown collection error", request_count: propertyRunFetchCount() - fetchesBefore });
      results.push({ market, source: adapter.sourceKey, outcome: "failed", error: code });
    }
  }
  return NextResponse.json({ ok: true, upstreamFetches: propertyRunFetchCount(), results });
}
