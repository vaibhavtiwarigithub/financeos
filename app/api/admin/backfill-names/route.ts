// POST /api/admin/backfill-names
// One-shot: finds all fundamental_facts rows where Name is missing,
// fetches company name+sector from Finnhub (US) or Yahoo (India),
// and patches just those fields into the JSONB values column.
// Returns a summary of what was updated.
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { fetchFinnhubOverview } from "@/lib/data/fundamentals";
import { fetchIndiaOverview } from "@/lib/india-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — Vercel hobby = 60s, Pro = 300s

export async function POST() {
  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  // Get all latest fundamental_facts rows where Name is null
  const { data: missing, error } = await sb
    .from("fundamental_facts")
    .select("id, symbol, market, values")
    .eq("is_latest", true)
    .eq("metric_set", "ttm_overview")
    .is("values->Name" as any, null)
    .order("symbol");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!missing?.length) return NextResponse.json({ updated: 0, message: "Nothing to backfill" });

  let updated = 0, failed = 0;
  const results: { symbol: string; market: string; name?: string; sector?: string; status: string }[] = [];

  for (const row of missing) {
    try {
      let name: string | null = null;
      let sector: string | null = null;

      if (row.market === "india") {
        const ov = await fetchIndiaOverview(row.symbol, { maxAgeDays: 30 }).catch(() => ({} as Record<string,string>));
        name   = ov.Name   ?? null;
        sector = ov.Sector ?? null;
      } else {
        const ov = await fetchFinnhubOverview(row.symbol, 30).catch(() => ({} as Record<string,string>));
        name   = ov.Name   ?? null;
        sector = ov.Sector ?? null;
      }

      if (!name && !sector) { results.push({ symbol: row.symbol, market: row.market, status: "no_data" }); continue; }

      // JSONB merge: only patch the missing fields, preserve everything else
      const patch: Record<string, string> = {};
      if (name)   patch.Name   = name;
      if (sector && !(row.values as any)?.Sector) patch.Sector = sector;

      const { error: upErr } = await sb
        .from("fundamental_facts")
        .update({ values: { ...(row.values as object), ...patch } })
        .eq("id", row.id);

      if (upErr) { failed++; results.push({ symbol: row.symbol, market: row.market, status: "error" }); }
      else        { updated++; results.push({ symbol: row.symbol, market: row.market, name: name ?? undefined, sector: sector ?? undefined, status: "ok" }); }

      // Rate-limit: Finnhub allows 60/min; Yahoo is generous but be polite
      await new Promise(r => setTimeout(r, row.market === "india" ? 300 : 1100));
    } catch {
      failed++;
      results.push({ symbol: row.symbol, market: row.market, status: "exception" });
    }
  }

  return NextResponse.json({ total: missing.length, updated, failed, results });
}
