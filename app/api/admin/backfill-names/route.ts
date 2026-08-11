// POST /api/admin/backfill-names
//
// Fills missing company Name (and Sector where absent) into fundamental_facts.values.
//
// Two things this deliberately does NOT do:
//
//  1. It does not filter in PostgREST. The previous version used
//     `.is("values->Name", null)`, which does not select JSONB-missing keys the
//     way it reads — a key that is absent is not the same as a key whose value is
//     JSON null, and the filter matched nothing, so the button reported "nothing
//     to backfill" while 133 of 184 rows had no name. The table is ~200 rows;
//     filtering in JS is both correct and cheap.
//
//  2. It does not route India through fetchIndiaOverview. That path uses Yahoo's
//     quoteSummary, which needs a cookie+crumb handshake that can fail
//     independently of the data being available. Yahoo's CHART endpoint returns
//     meta.longName for NSE tickers with no crumb at all (verified live), so the
//     name backfill uses the endpoint with the fewest ways to fail.
//
// Writes are additive: the existing JSONB is spread first, so a present value is
// never overwritten and no other metric is disturbed.
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function usProfile(symbol: string): Promise<{ name: string | null; sector: string | null }> {
  const key = process.env.FINNHUB_API_KEY ?? "";
  if (!key) return { name: null, sector: null };
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return { name: null, sector: null };
    const p = await res.json();
    return { name: p?.name ?? null, sector: p?.finnhubIndustry ?? null };
  } catch { return { name: null, sector: null }; }
}

async function indiaProfile(symbol: string): Promise<{ name: string | null; sector: string | null }> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return { name: null, sector: null };
    const j = await res.json();
    const m = j?.chart?.result?.[0]?.meta ?? {};
    // Chart meta carries no sector; Sector for India already comes from the
    // quoteSummary path during normal research and is 49/49 populated.
    return { name: m.longName ?? m.shortName ?? null, sector: null };
  } catch { return { name: null, sector: null }; }
}

export async function POST() {
  // Owner-only: this mutates stored fundamentals and spends Finnhub quota.
  const denied = await requireOwner();
  if (denied) return denied;

  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  const { data: all, error } = await sb
    .from("fundamental_facts")
    .select("id, symbol, market, values")
    .eq("is_latest", true)
    .eq("metric_set", "ttm_overview")
    .order("symbol");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const missing = (all ?? []).filter(r => {
    const v = (r.values ?? {}) as Record<string, unknown>;
    return !v.Name;
  });
  if (!missing.length) {
    return NextResponse.json({ total: 0, updated: 0, failed: 0, message: "Every symbol already has a name", results: [] });
  }

  let updated = 0, failed = 0, noData = 0;
  const results: { symbol: string; market: string; name?: string; status: string }[] = [];

  for (const row of missing) {
    const market = row.market ?? "us";
    try {
      const got = market === "india" ? await indiaProfile(row.symbol) : await usProfile(row.symbol);
      if (!got.name && !got.sector) {
        noData++;
        results.push({ symbol: row.symbol, market, status: "no_data" });
      } else {
        const existing = (row.values ?? {}) as Record<string, unknown>;
        const patch: Record<string, unknown> = { ...existing };
        if (got.name) patch.Name = got.name;
        if (got.sector && !existing.Sector) patch.Sector = got.sector;

        const { error: upErr } = await sb.from("fundamental_facts").update({ values: patch }).eq("id", row.id);
        if (upErr) { failed++; results.push({ symbol: row.symbol, market, status: "write_error" }); }
        else { updated++; results.push({ symbol: row.symbol, market, name: got.name ?? undefined, status: "ok" }); }
      }
    } catch {
      failed++;
      results.push({ symbol: row.symbol, market, status: "exception" });
    }
    // Finnhub free is 60/min; Yahoo's chart endpoint is unmetered but unofficial.
    await sleep(market === "india" ? 250 : 1100);
  }

  return NextResponse.json({ total: missing.length, updated, no_data: noData, failed, results });
}
