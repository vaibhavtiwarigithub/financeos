// GET /api/research/universe
// All unique researched symbols with latest scores + fundamental facts.
// Used by the Fundamentals landing page (/dashboard/research).
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export async function GET() {
  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  // All rows newest-first; dedupe client-side (avoids DISTINCT ON dialect issues)
  const { data: scores, error } = await sb
    .from("signal_score_history")
    .select("symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, direction, created_at")
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!scores?.length) return NextResponse.json({ symbols: [] });

  // Dedupe: keep latest row per symbol+market
  const seen = new Map<string, typeof scores[0]>();
  for (const row of scores) {
    const key = `${row.symbol}:${row.market ?? "us"}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  const latest = [...seen.values()];

  // Pull fundamental_facts for these symbols
  const symbols = latest.map(r => r.symbol);
  const { data: facts } = await sb
    .from("fundamental_facts")
    .select("symbol, market, values")
    .in("symbol", symbols)
    .eq("is_latest", true)
    .eq("metric_set", "ttm_overview");

  const factsMap = new Map<string, Record<string, string>>();
  for (const f of facts ?? []) {
    const key = `${f.symbol}:${f.market ?? "us"}`;
    if (!factsMap.has(key)) factsMap.set(key, f.values as Record<string, string>);
  }

  const out = latest.map(r => ({
    symbol: r.symbol,
    market: r.market ?? "us",
    analyst_score: Number(r.analyst_score),
    fundamental_score: Number(r.fundamental_score),
    technical_score: Number(r.technical_score),
    sentiment_score: Number(r.sentiment_score),
    macro_score: Number(r.macro_score),
    direction: r.direction,
    last_researched_at: r.created_at,
    fundamentals: factsMap.get(`${r.symbol}:${r.market ?? "us"}`) ?? null,
  })).sort((a, b) => b.analyst_score - a.analyst_score);

  return NextResponse.json({ symbols: out });
}
