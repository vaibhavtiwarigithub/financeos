// GET /api/research/universe?mode=latest|all_runs
// latest (default): one row per symbol — latest scores + fundamentals + last executed BUY/SELL
// all_runs: every signal_score_history row — full audit log of every research decision
import { NextRequest, NextResponse } from "next/server";
import { breakdownWithStatus, finiteNumber } from "@/lib/research/universe-truth";
import { requireOwner } from "@/lib/auth/require-owner";
import { latestExecutionEvent, liveDecisionEvents, paperTradeEvents } from "@/lib/research/trade-timeline";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Full select including breakdown cols (added by migrations after 2026-08-10).
// If those columns don't exist yet the query will error; we fall back to the
// base select automatically so the page still shows rows while migration is pending.
const SCORE_SELECT_FULL = "symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, created_at, fundamental_breakdown, technical_breakdown, sentiment_breakdown, macro_breakdown";
const SCORE_SELECT_BASE = "symbol, market, analyst_score, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, direction, created_at";

// PostgREST caps every response at 1000 rows regardless of .limit(n) — asking for
// 5000 silently returns only the newest 1000. That truncation is what previously
// made the Fundamentals table show 158 symbols going back only ~5 days instead of
// the real 185 symbols going back to the first run. Page with .range() instead.
const PAGE = 1000;
const MAX_ROWS = 20000; // safety stop; table is ~3.5k rows as of 2026-08

async function pagedSelect(
  sb: ReturnType<typeof createServiceClient>,
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

async function queryScoreHistory(sb: ReturnType<typeof createServiceClient>): Promise<any[]> {
  // Try full select (breakdown cols); fall back to base if columns missing in DB
  const full = await pagedSelect(sb, SCORE_SELECT_FULL);
  if (!full.error) return full.rows;

  const base = await pagedSelect(sb, SCORE_SELECT_BASE);
  if (base.error) throw new Error(base.error);
  return base.rows;
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const mode = req.nextUrl.searchParams.get("mode") ?? "latest";
  // requireOwner authenticated the caller above. Use the service client for
  // the privileged server-side join: broker_orders intentionally grants no
  // authenticated-role SELECT, and feeding browser cookies to a service-key
  // client silently replaced its service JWT with the user session.
  const sb = createServiceClient();

  // ── All-runs mode: raw point-in-time audit log ────────────────────────────
  if (mode === "all_runs") {
    let data: any[];
    try { data = await queryScoreHistory(sb); }
    catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 500 }); }

    return NextResponse.json({
      symbols: (data ?? []).map((r: any) => ({
        symbol: r.symbol,
        market: r.market ?? "us",
        analyst_score: finiteNumber(r.analyst_score),
        fundamental_score: finiteNumber(r.fundamental_score),
        technical_score: finiteNumber(r.technical_score),
        sentiment_score: finiteNumber(r.sentiment_score),
        macro_score: finiteNumber(r.macro_score),
        insider_score: finiteNumber(r.insider_score),
        direction: r.direction,
        last_researched_at: r.created_at,
        // Historical rows must use the immutable per-run breakdown below. A
        // current TTM snapshot would rewrite history every time fundamentals
        // refresh and make the chart look point-in-time when it is not.
        fundamentals: null,
        last_trade: null,
        fundamental_breakdown: breakdownWithStatus(r.fundamental_breakdown, "fundamental", r.market ?? "us"),
        technical_breakdown: breakdownWithStatus(r.technical_breakdown, "technical", r.market ?? "us"),
        sentiment_breakdown: breakdownWithStatus(r.sentiment_breakdown, "sentiment", r.market ?? "us"),
        macro_breakdown: breakdownWithStatus(r.macro_breakdown, "macro", r.market ?? "us"),
      })),
    });
  }

  // ── Latest mode: one row per symbol + fundamentals + last trade ───────────
  let scoresData: any[];
  try { scoresData = await queryScoreHistory(sb); }
  catch (e: any) { return NextResponse.json({ error: String(e?.message) }, { status: 500 }); }

  // `tainted` is a real boolean here: 153 rows false, 2 true, NONE null. The old
  // .is("tainted", null) therefore matched zero rows and the Trade column was
  // permanently blank. Exclude only genuinely tainted lots, and tolerate null in
  // case older rows predate the column default.
  const [tradesRes, liveOrdersRes] = await Promise.all([
    sb.from("paper_trades")
      .select("id,symbol,market,order_side,qty,fill_price,entry_price,exit_price,executed_at,exit_at,closed_at,realized_pnl_pct,pnl_pct,analyst_score,rationale,exit_reason")
      .or("tainted.is.null,tainted.is.false")
      .order("executed_at", { ascending: false })
      .limit(1000),
    sb.from("broker_orders")
      .select("id,symbol,market,side,qty,status,created_at,submitted_at,closed_at,avg_fill_price,filled_qty,error")
      .order("created_at", { ascending: false })
      .limit(1000),
  ]);
  if (tradesRes.error || liveOrdersRes.error) {
    return NextResponse.json({ error: tradesRes.error?.message ?? liveOrdersRes.error?.message }, { status: 500 });
  }

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

  // Expand the lot ledger into actions. Closed long lots remain order_side=buy,
  // with their SELL recorded in exit_at/exit_price; reading order_side directly
  // made the Trade column permanently show BUY even after 137 real paper exits.
  interface TradeInfo { side: "buy" | "sell"; date: string; analyst_score: number | null; venue: "paper" | "live"; status: string }
  const eventsBySymbol = new Map<string, ReturnType<typeof paperTradeEvents>>();
  for (const t of (tradesRes.data ?? []) as any[]) {
    const key = `${t.symbol}:${t.market ?? "us"}`;
    const events = eventsBySymbol.get(key) ?? [];
    events.push(...paperTradeEvents([t]));
    eventsBySymbol.set(key, events);
  }
  for (const o of (liveOrdersRes.data ?? []) as any[]) {
    const key = `${o.symbol}:${o.market ?? "us"}`;
    const events = eventsBySymbol.get(key) ?? [];
    events.push(...liveDecisionEvents([], [o]));
    eventsBySymbol.set(key, events);
  }
  const tradeMap = new Map<string, TradeInfo>();
  for (const [key, events] of eventsBySymbol) {
    const latest = latestExecutionEvent(events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
    if (latest) tradeMap.set(key, {
      side: latest.side,
      date: latest.occurred_at,
      analyst_score: latest.analyst_score,
      venue: latest.venue,
      status: latest.status,
    });
  }

  const out = latest.map((r: any) => ({
    symbol: r.symbol,
    market: r.market ?? "us",
    analyst_score: finiteNumber(r.analyst_score),
    fundamental_score: finiteNumber(r.fundamental_score),
    technical_score: finiteNumber(r.technical_score),
    sentiment_score: finiteNumber(r.sentiment_score),
    macro_score: finiteNumber(r.macro_score),
    insider_score: finiteNumber(r.insider_score),
    direction: r.direction,
    last_researched_at: r.created_at,
    fundamentals: factsMap.get(`${r.symbol}:${r.market ?? "us"}`) ?? null,
    last_trade: tradeMap.get(`${r.symbol}:${r.market ?? "us"}`) ?? null,
    fundamental_breakdown: breakdownWithStatus(r.fundamental_breakdown, "fundamental", r.market ?? "us"),
    technical_breakdown: breakdownWithStatus(r.technical_breakdown, "technical", r.market ?? "us"),
    sentiment_breakdown: breakdownWithStatus(r.sentiment_breakdown, "sentiment", r.market ?? "us"),
    macro_breakdown: breakdownWithStatus(r.macro_breakdown, "macro", r.market ?? "us"),
  })).sort((a: any, b: any) => (b.analyst_score ?? -Infinity) - (a.analyst_score ?? -Infinity));

  return NextResponse.json({ symbols: out });
}
