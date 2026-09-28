import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { avCachedFetch } from "@/lib/av-cache";
import { assessCorporateActionPayload, selectCorporateActionCoverageBatch, type CorporateActionKind } from "@/lib/shadows/corporate-action-coverage";

export const dynamic = "force-dynamic";

// Phase 1: Corporate Actions sync
// Fetches splits + dividends from Alpha Vantage for held/watchlist symbols.
// Writes to corporate_actions table. Used by paper-trade NAV adjustment.

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const supabase = await import("@/lib/supabase/server").then(m => m.createClient());
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";
  if (!avKey) return NextResponse.json({ error: "No ALPHA_VANTAGE_API_KEY" }, { status: 500 });

  // Get symbols from open positions + watchlist
  const [{ data: positions }, { data: watchlist }] = await Promise.all([
    supabase.from("paper_positions").select("symbol"),
    supabase.from("watchlist").select("symbol").limit(20),
  ]);

  const candidates = [...new Set([
    ...(positions ?? []).map((p: any) => p.symbol as string),
    ...(watchlist ?? []).map((w: any) => w.symbol as string),
  ])];
  const coverageRead = candidates.length
    ? await supabase.from("corporate_action_source_coverage")
      .select("symbol,action_type,status,checked_at")
      .in("symbol", candidates)
      .order("checked_at", { ascending: false })
    : { data: [], error: null };
  if (coverageRead.error) {
    return NextResponse.json({ success: false, error: `Corporate-action coverage ledger unavailable: ${coverageRead.error.message}`, persisted: false }, { status: 503 });
  }
  const priorCoverage = coverageRead.data;
  // Fairly rotate the bounded batch: unobserved/oldest pairs go first, including
  // repeated failures. This avoids permanently selecting the first five rows.
  const symbols = selectCorporateActionCoverageBatch(candidates, priorCoverage ?? [], 5); // at most 10 AV endpoints per invocation

  const results: { symbol: string; status: string; splits: number; dividends: number; coverage: Record<string, unknown> }[] = [];
  const errors: { symbol: string; error: string }[] = [];

  for (const symbol of symbols) {
    try {
      const coverage: Record<string, unknown> = {};
      let splitsAdded = 0;
      let dividendsAdded = 0;
      let symbolStatus = "complete";

      // Sequentially fetch the two source series. Each fetch goes through the
      // shared AV cache and hard daily-budget reservation. A null/stale result
      // is recorded as a blocker, never as an empty event series.
      for (const kind of ["split", "dividend"] as const satisfies readonly CorporateActionKind[]) {
        const cacheKey = `${kind === "split" ? "SPLITS" : "DIVIDENDS"}:${symbol}`;
        const functionName = kind === "split" ? "SPLITS" : "DIVIDENDS";
        const payload = await avCachedFetch(
          cacheKey,
          `https://www.alphavantage.co/query?function=${functionName}&symbol=${encodeURIComponent(symbol)}&apikey=${avKey}`,
          10000,
          undefined,
          30,
          30,
        );
        const { data: cachedRow, error: cacheError } = await supabase.from("av_cache")
          .select("fetched_at,cache_date")
          .eq("cache_key", cacheKey)
          .order("cache_date", { ascending: false })
          .limit(1)
          .maybeSingle();
        const fetchedAt = cacheError ? null : cachedRow?.fetched_at ?? null;
        const assessment = payload == null
          ? { status: "error" as const, recordsCount: 0, reason: "Provider returned no payload (request failed or budget denied)." }
          : assessCorporateActionPayload({ kind, payload, providerFetchedAt: fetchedAt, maxAgeDays: 30 });
        const { error: coverageError } = await supabase.from("corporate_action_source_coverage").insert({
          symbol,
          action_type: kind,
          source: "alpha_vantage",
          status: assessment.status,
          provider_fetched_at: fetchedAt,
          records_count: assessment.recordsCount,
          details: { reason: assessment.reason },
        });
        if (coverageError) throw new Error(`Could not persist ${kind} coverage for ${symbol}: ${coverageError.message}`);
        coverage[kind] = { status: assessment.status, recordsCount: assessment.recordsCount, providerFetchedAt: fetchedAt, reason: assessment.reason };
        if (assessment.status !== "complete") {
          symbolStatus = assessment.status;
          continue;
        }

        const records = (payload as { data: Record<string, unknown>[] }).data;
        for (const row of records) {
          const exDate = kind === "split"
            ? String(row.effective_date ?? row.ex_date)
            : String(row.ex_dividend_date ?? row.ex_date);
          const amount = Number(kind === "split" ? row.split_factor ?? row.ratio : row.amount);
          const record = kind === "split"
            ? { symbol, action_type: "split", ex_date: exDate, split_ratio: amount, source: "alpha_vantage", source_tier: 2 }
            : { symbol, action_type: "dividend", ex_date: exDate, dividend_amount: amount, dividend_type: "regular", source: "alpha_vantage", source_tier: 2 };
          const { error } = await supabase.from("corporate_actions").upsert(record, { onConflict: "symbol,action_type,ex_date" });
          if (error) throw new Error(`Could not persist ${kind} event for ${symbol} on ${exDate}: ${error.message}`);
          if (kind === "split") splitsAdded++;
          else dividendsAdded++;
        }
      }
      results.push({ symbol, status: symbolStatus, splits: splitsAdded, dividends: dividendsAdded, coverage });
    } catch (e: any) {
      errors.push({ symbol, error: e?.message ?? "unknown" });
    }
  }

  const success = errors.length === 0 && results.every((row) => row.status === "complete");
  return NextResponse.json({ success, persisted: results.length > 0, symbols_processed: symbols.length, results, errors }, { status: errors.length ? 500 : 200 });
}

// GET: fetch corporate actions for a symbol
export async function GET(req: NextRequest) {
  const supabase = createServiceClient();
  const symbol = req.nextUrl.searchParams.get("symbol");
  const type   = req.nextUrl.searchParams.get("type"); // 'split' | 'dividend'
  const since  = req.nextUrl.searchParams.get("since"); // date string

  let query = supabase
    .from("corporate_actions")
    .select("*")
    .order("ex_date", { ascending: false })
    .limit(50);

  if (symbol) query = query.eq("symbol", symbol);
  if (type)   query = query.eq("action_type", type);
  if (since)  query = query.gte("ex_date", since);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ actions: data ?? [] });
}
