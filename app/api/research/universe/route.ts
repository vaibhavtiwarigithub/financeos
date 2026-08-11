// GET /api/research/universe?mode=latest|all_runs
// latest (default): one row per symbol — latest scores + fundamentals + last paper trade
// all_runs: every signal_score_history row — full audit log of every research decision
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

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
    const { data, error } = await sb
      .from("signal_score_history")
      .select("symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, direction, created_at")
      .order("created_at", { ascending: false })
      .limit(2000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // Unique symbols → join latest fundamentals so P/E, PEG etc are visible
    const allSyms = [...new Set((data ?? []).map(r => r.symbol))];
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
      symbols: (data ?? []).map(r => ({
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
      })),
    });
  }

  // ── Latest mode: one row per symbol + fundamentals + last trade ───────────
  const [scoresRes, tradesRes] = await Promise.all([
    sb.from("signal_score_history")
      .select("symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, direction, created_at")
      .order("created_at", { ascending: false })
      .limit(5000),
    sb.from("paper_trades")
      .select("symbol, order_side, executed_at, exit_at, analyst_score")
      .is("tainted", null)
      .order("executed_at", { ascending: false })
      .limit(2000),
  ]);

  if (scoresRes.error) return NextResponse.json({ error: scoresRes.error.message }, { status: 500 });
  if (!scoresRes.data?.length) return NextResponse.json({ symbols: [] });

  // Dedupe: keep latest per symbol+market
  const seen = new Map<string, typeof scoresRes.data[0]>();
  for (const row of scoresRes.data) {
    const key = `${row.symbol}:${row.market ?? "us"}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  const latest = [...seen.values()];
  const symbols = latest.map(r => r.symbol);

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
    last_trade: tradeMap.get(r.symbol) ?? null,
  })).sort((a, b) => b.analyst_score - a.analyst_score);

  return NextResponse.json({ symbols: out });
}
