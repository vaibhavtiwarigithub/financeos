// POST /api/admin/refresh-fundamentals?market=us|india|all&limit=40&offset=0
//
// Forced re-fetch of fundamentals for every symbol in fundamental_facts, bypassing
// the provider cache, and re-capture through captureFundamentalsFact so changed
// values append a new PIT vintage.
//
// Why this exists: a provider-key mapping fix changes what a fetch RETURNS, but the
// normal path serves cached payloads (fundamentals cache for 7 days) and only writes
// when the payload hash changes. So a mapping fix stays invisible for days. This job
// forces the call and lets the append-on-change logic do the rest.
//
// Batched deliberately. Finnhub free is 60 calls/min and fetchFinnhubOverview spends
// TWO calls per symbol (metric + profile2), so a US symbol costs ~2.2s of pacing.
// Vercel caps the request at 300s, so the caller pages through with `offset` until
// `next_offset` comes back null rather than trying to do 184 symbols in one request.
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { fetchFinnhubOverview } from "@/lib/data/fundamentals";
import { fetchIndiaOverview } from "@/lib/india-data";
import { captureFundamentalsFact } from "@/lib/data/pit-fundamentals";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Finnhub: 60 req/min, 2 reqs per symbol → 2200ms between symbols keeps us under.
const US_PACE_MS = 2200;
// Yahoo has no published cap but is unofficial; stay polite.
const INDIA_PACE_MS = 400;

const DEFAULT_BATCH = 40;

interface Result {
  symbol: string;
  market: string;
  status: "updated" | "unchanged" | "no_data" | "error";
  new_fields?: string[];
}

export async function POST(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const marketFilter = (sp.get("market") ?? "all").toLowerCase();
  const limit = Math.min(Number(sp.get("limit") ?? DEFAULT_BATCH) || DEFAULT_BATCH, 100);
  const offset = Number(sp.get("offset") ?? 0) || 0;

  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  // Target set: every symbol we already track fundamentals for. Ordered by symbol so
  // paging is stable across requests even as rows are rewritten mid-run.
  let q = sb
    .from("fundamental_facts")
    .select("symbol, market, values", { count: "exact" })
    .eq("is_latest", true)
    .eq("metric_set", "ttm_overview")
    .order("symbol");
  if (marketFilter === "us" || marketFilter === "india") q = q.eq("market", marketFilter);

  const { data: targets, count, error } = await q.range(offset, offset + limit - 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!targets?.length) {
    return NextResponse.json({ done: true, total: count ?? 0, processed: 0, next_offset: null, results: [] });
  }

  const results: Result[] = [];
  let updated = 0, unchanged = 0, failed = 0;

  for (const row of targets) {
    const market = (row.market ?? "us") as "us" | "india";
    const before = (row.values ?? {}) as Record<string, string>;
    try {
      const overview = market === "india"
        ? await fetchIndiaOverview(row.symbol, { maxAgeDays: 1, forceRefresh: true })
            .catch(() => ({} as Record<string, string>))
        // ETFs legitimately return nothing from Finnhub; that is a no_data, not an error.
        : await fetchFinnhubOverview(row.symbol, 7, true)
            .catch(() => ({} as Record<string, string>));

      const realFields = Object.keys(overview).filter(k => k !== "Symbol");
      if (realFields.length < 2) {
        results.push({ symbol: row.symbol, market, status: "no_data" });
        continue;
      }

      // Which keys are genuinely new vs what is stored — this is the whole point of
      // the job, so report it rather than just a count.
      const newFields = realFields.filter(k => before[k] == null || before[k] === "");

      const vintage = await captureFundamentalsFact(sb as never, {
        symbol: row.symbol,
        market,
        values: overview,
        source: market === "india" ? "yahoo" : "finnhub",
      });

      if (vintage) {
        updated++;
        results.push({ symbol: row.symbol, market, status: "updated", new_fields: newFields });
      } else {
        // captureFundamentalsFact returns null on an identical payload (dedup) too.
        unchanged++;
        results.push({ symbol: row.symbol, market, status: "unchanged" });
      }
    } catch {
      failed++;
      results.push({ symbol: row.symbol, market, status: "error" });
    }

    await new Promise(r => setTimeout(r, market === "india" ? INDIA_PACE_MS : US_PACE_MS));
  }

  const nextOffset = offset + targets.length;
  const done = count == null ? targets.length < limit : nextOffset >= count;

  return NextResponse.json({
    done,
    total: count ?? null,
    processed: targets.length,
    offset,
    next_offset: done ? null : nextOffset,
    updated, unchanged, failed,
    results,
  });
}
