import { NextRequest, NextResponse } from "next/server";
import { fetchNseEquityList } from "@/lib/nse-data";
import { indiaScreenUniverse } from "@/lib/india-universe";
import { fetchIndiaOverview, fetchYahooCandles } from "@/lib/india-data";
import { computeTechnicals } from "@/lib/data/technicals";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
// Rotates ~600 NSE names/run — needs Vercel Pro (300s cap) or higher; Hobby's
// lower ceiling will truncate this mid-run.
export const maxDuration = 300;

// Rotating pre-score cache for the broader NSE equity universe.
//
// The live India scan (app/api/scan/india) is honestly capped at ~NIFTY-100
// because scoring ~2000 names name-by-name against Yahoo would take minutes and
// blow past request timeouts. This cron pre-scores the full NSE list into
// `india_screen_cache` in bounded slices. The cache API exposes fresh/stale
// coverage explicitly; it never claims every NSE name is simultaneously fresh.
//
// One run is capped at MAX_PER_RUN symbols, processed oldest-scored-first (names
// never cached come first), so consecutive nightly runs rotate through the whole
// ~2000 universe over a few nights and then keep the oldest rows fresh.
//
// Concurrency: Yahoo rate-limits, so we fetch in batches of 8 with a short pause
// between batches (mirrors the live scan route).

const BATCH_SIZE = 8;
const BATCH_PAUSE_MS = 400;
const MAX_PER_RUN = 600;

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sb = createServiceClient();

    // Full NSE list (~2000 .NS), fall back to ~NIFTY-100 if the NSE feed is blocked.
    let universe = await fetchNseEquityList();
    if (!universe.length) universe = indiaScreenUniverse();
    universe = [...new Set(universe)];
    const total = universe.length;

    // Order by staleness: names not yet in cache first, then oldest scored_at.
    // Read the existing cache's scored_at map (bounded columns, whole table is small).
    const { data: cachedRows } = await sb
      .from("india_screen_cache")
      .select("symbol, scored_at");
    const scoredAt = new Map<string, string>();
    for (const r of cachedRows ?? []) scoredAt.set(r.symbol, r.scored_at);

    const ordered = [...universe].sort((a, b) => {
      const ta = scoredAt.get(a);
      const tb = scoredAt.get(b);
      if (ta == null && tb == null) return 0;
      if (ta == null) return -1;             // never-scored first
      if (tb == null) return 1;
      return ta.localeCompare(tb);           // oldest scored_at next (ISO sorts lexically)
    });

    const slice = ordered.slice(0, MAX_PER_RUN);

    let scored = 0;
    let skipped = 0;

    for (let i = 0; i < slice.length; i += BATCH_SIZE) {
      const batch = slice.slice(i, i + BATCH_SIZE);
      const rows = await Promise.all(batch.map(async (symbol) => {
        try {
          const [ov, candles] = await Promise.all([
            fetchIndiaOverview(symbol),
            fetchYahooCandles(symbol, "6mo"),
          ]);

          const tech = computeTechnicals(candles);
          const price = candles.length ? candles[candles.length - 1].close : null;
          const aboveMa50 =
            tech.priceVsEma50 === "above" ? true : tech.priceVsEma50 === "below" ? false : null;

          // Need at least a price or fundamentals to be worth caching.
          if (price == null && (!ov || Object.keys(ov).length === 0)) return null;

          const num = (v: string | undefined) =>
            v != null && v !== "" && !Number.isNaN(parseFloat(v)) ? parseFloat(v) : null;

          return {
            symbol,
            name: ov?.Name ?? null,
            price,
            pe: num(ov?.PERatio),
            rsi: tech.rsi14,
            ema50: tech.ema50,
            above_ma50: aboveMa50,
            profit_margin: num(ov?.ProfitMargin),
            roe: num(ov?.ReturnOnEquityTTM),
            rev_growth: num(ov?.QuarterlyRevenueGrowthYOY),
            sector: ov?.Sector ?? null,
            scored_at: new Date().toISOString(),
          };
        } catch {
          return null;
        }
      }));

      const upsertable = rows.filter((r): r is NonNullable<typeof r> => r != null);
      skipped += batch.length - upsertable.length;

      if (upsertable.length) {
        const { error } = await sb
          .from("india_screen_cache")
          .upsert(upsertable, { onConflict: "symbol" });
        if (error) skipped += upsertable.length;
        else scored += upsertable.length;
      }

      if (i + BATCH_SIZE < slice.length) await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
    }

    return NextResponse.json({ scored, skipped, total, processed: slice.length });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
