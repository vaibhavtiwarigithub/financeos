import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

export const dynamic = "force-dynamic";

/**
 * ZIP-level Zillow ZHVI area context for a single ZIP. Read-only surface for
 * MyPropertiesWorkspace — never the property's own value, never blended with
 * it. See lib/property/sources.ts (ZillowZhviZipAdapter) for the source.
 */
export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const url = new URL(req.url);
  const market = url.searchParams.get("market");
  const zip = (url.searchParams.get("zip") ?? "").trim();
  if (!market || !PROPERTY_MARKETS.some((m) => m.id === market)) return NextResponse.json({ error: "Unknown market" }, { status: 400 });
  if (!/^\d{5}$/.test(zip)) return NextResponse.json({ points: [], zip, market, available: false });

  const svc = createServiceClient();
  const { data, error } = await svc.from("property_zip_observations")
    .select("as_of, value, source_version, collected_at")
    .eq("market_slug", market as PropertyMarketId)
    .eq("zip", zip)
    .eq("metric_key", "zhvi_all_homes")
    .order("collected_at", { ascending: false })
    .limit(120);
  if (error) return NextResponse.json({ error: "ZIP area context is temporarily unavailable" }, { status: 503 });

  const newestByMonth = new Map<string, any>();
  for (const row of data ?? []) if (!newestByMonth.has(String(row.as_of))) newestByMonth.set(String(row.as_of), row);
  const rows = [...newestByMonth.values()].sort((a, b) => String(a.as_of).localeCompare(String(b.as_of))).slice(-13);
  const points = rows.map((row: any) => ({ asOf: String(row.as_of), value: Number(row.value) }));
  return NextResponse.json({
    market, zip,
    available: points.length > 0,
    points,
    sourceVersion: rows.length ? rows[rows.length - 1].source_version ?? null : null,
    sourceName: "Zillow Research ZHVI (ZIP)",
    sourceUrl: "https://www.zillow.com/research/data/",
  });
}
