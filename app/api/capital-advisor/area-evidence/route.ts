import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";

const MARKETS = new Set(["austin", "phoenix", "bengaluru"]);

export async function GET(req: NextRequest) {
  const gate = await requireOwner(); if (gate) return gate;
  const market = new URL(req.url).searchParams.get("market") ?? "";
  if (!MARKETS.has(market)) return NextResponse.json({ error: "Unknown property market" }, { status: 400 });
  const { data, error } = await createServiceClient().from("property_market_observations")
    .select("source_key, metric_key, value, native_unit, as_of, collected_at, revision_state")
    .eq("geography_slug", market).in("metric_key", ["price_index", "mortgage_rate", "unemployment_rate"])
    .order("as_of", { ascending: false }).limit(100);
  if (error) return NextResponse.json({ error: "Area evidence is temporarily unavailable" }, { status: 503 });
  const latest = new Map<string, any>();
  for (const row of data ?? []) if (!latest.has(row.metric_key)) latest.set(row.metric_key, row);
  return NextResponse.json({ market, evidence: Array.from(latest.values()), coverage: market === "bengaluru" ? "contract_pending" : "metro_only" });
}
