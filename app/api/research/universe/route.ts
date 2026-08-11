// GET /api/research/universe?mode=latest|all_runs
// latest (default): one row per symbol — latest scores + fundamentals + last paper trade
// all_runs: every signal_score_history row — full audit log of every research decision
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

// Full select including breakdown cols (added by migrations after 2026-08-10).
// If those columns don't exist yet the query will error; we fall back to the
// base select automatically so the page still shows rows while migration is pending.
const SCORE_SELECT_FULL = "symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, direction, created_at, technical_breakdown, sentiment_breakdown, macro_breakdown";
const SCORE_SELECT_BASE = "symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, direction, created_at";

// PostgREST caps every response at 1000 rows regardless of .limit(n) — asking for
// 5000 silently returns only the newest 1000. That truncation is what previously
// made the Fundamentals table show 158 symbols going back only ~5 days instead of
// the real 185 symbols going back to the first run. Page with .range() instead.
const PAGE = 1000;
const MAX_ROWS = 20000; // safety stop; table is ~3.5k rows as of 2026-08

async function pagedSelect(
  sb: ReturnType<typeof createServerClient>,
  select: string,
): Promise<{ rows: any[]; error: string | null }> {
  const rows: any[] = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE) {
    const { data, error } = await sb
      .from("signal_score_history")
      .select(select)
      .order("created_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    if (!data?.length) break;
    rows.push(...(data as any[]));
    if (data.length < PAGE) break; // last page
  }
  return { rows, error: null };
}

async function queryScoreHistory(sb: ReturnType<typeof createServerClient>): Promise<any[]> {
  // Try full select (breakdown cols); fall back to base if columns missing in DB
  const full = await pagedSelect(sb, SCORE_SELECT_FULL);
  if (!full.error) return full.rows;

  const base = await pagedSelect(sb, SCORE_SELECT_BASE);
  if (base.error) throw new Error(base.error);
  return base.rows;
}

export async function GET(req: NextRequest) {
  const mode = req.nextUrl.searchParams.get("mode") ?? "latest";
  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  // ── All-runs mode: raw audit log + latest fundamentals per symbol ──────────
  if (mode === "all_runs") {
    let data: any[];
    try { data = await queryScoreHistory(sb); }
    catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 500 }); }

    // Unique symbols → join latest fundamentals so P/E, PEG etc are visible
    const allSyms = [...new Set((data ?? []).map((r: any) => r.symbol as string))];
    const { data: facts } = await sb
      .from("fundamental_facts")
      .select("symbol, market, values")
      .in("symbol", allSyms)
      .eq("is_latest", true)
      .eq("metric_set", "ttm_overview");

    const factsMap = new Map<string, Record<string, string>>();
    for (const f of facts ?? []) {
      const key = `${f.symbol}:${f.market ?? "us"}`;
      if (!factsMap.has(key)) factsMap.set(key, f.values as Record<string, string>);
    }

    return NextResponse.json({
      symbols: (data ?? []).map((r: any) => ({
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
        last_trade: null,
        technical_breakdown: r.technical_breakdown ?? null,
        sentiment_breakdown: r.sentiment_breakdown ?? null,
        macro_breakdown: r.macro_breakdown ?? null,
      })),
    });
  }

  // ── Latest mode: one row per symbol + fundamentals + last trade ───────────
  let scoresData: any[];
  try { scoresData = await queryScoreHistory(sb); }
  catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 500 }); }

  const tradesRes = await sb.from("paper_trades")
    .select("symbol, order_side, executed_at, exit_at, analyst_score")
    .is("tainted", null)
    .order("executed_at", { ascending: false })
    .limit(2000);

  if (!scoresData?.length) return NextResponse.json({ symbols: [] });

  // Dedupe: keep latest per symbol+market
  const seen = new Map<string, any>();
  for (const row of scoresData) {
    const key = `${row.symbol}:${row.market ?? "us"}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  const latest = [...seen.values()];
  const symbols = latest.map((r: any) => r.symbol as string);

  // Fundamentals
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

  // Last paper trade per symbol
  interface TradeInfo { side: string; date: string; exit_at: string | null; analyst_score: number | null }
  const tradeMap = new Map<string, TradeInfo>();
  for (const t of (tradesRes.data ?? []) as any[]) {
    if (!tradeMap.has(t.symbol)) {
      tradeMap.set(t.symbol, {
        side: t.order_side,
        date: t.executed_at,
        exit_at: t.exit_at,
        analyst_score: t.analyst_score != null ? Number(t.analyst_score) : null,
      });
    }
  }

  const out = latest.map((r: any) => ({
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
    last_trade: tradeMap.get(r.symbol) ?? null,
    technical_breakdown: r.technical_breakdown ?? null,
    sentiment_breakdown: r.sentiment_breakdown ?? null,
    macro_breakdown: r.macro_breakdown ?? null,
  })).sort((a: any, b: any) => b.analyst_score - a.analyst_score);

  return NextResponse.json({ symbols: out });
}
