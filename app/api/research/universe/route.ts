// GET /api/research/universe?mode=latest|all_runs
// latest (default): one row per symbol — latest scores + fundamentals + last executed BUY/SELL
// all_runs: every signal_score_history row — full audit log of every research decision
import { NextRequest, NextResponse } from "next/server";
import { breakdownWithStatus, finiteNumber } from "@/lib/research/universe-truth";
import { requireViewerOrOwner } from "@/lib/auth/session-role";
import { latestExecutionEvent, liveDecisionEvents, paperTradeEvents } from "@/lib/research/trade-timeline";
import { createServiceClient } from "@/lib/supabase/service";
import { explainTradeWhy, TRADING_STAGES, type ObservationRow, type StageEventRow } from "@/lib/trading/trade-why";

export const dynamic = "force-dynamic";

// ── "Why" column read bounds ─────────────────────────────────────────────────
// Latest-per-symbol is reduced in code (no RPC/migration). Every read is limited
// to the symbols in this response, chunked, newest-first, and stops as soon as
// every market+symbol key has a row.
// ponytail: caps below; if they start binding (tables grow ~5k research rows a
// month), replace the scans with a distinct-on RPC.
const WHY_SYMBOL_CHUNK = 200;  // keeps .in() URLs well under PostgREST limits
const WHY_SCAN_CAP = 5000;     // rows per source per chunk
const WHY_OBS_KEY_CAP = 400;   // per-key decision_observations lookups (index: symbol, ts desc)
const WHY_OBS_CONCURRENCY = 10;

type Sb = ReturnType<typeof createServiceClient>;

async function scanNewestFirst(
  page: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: { message: string } | null }>,
  done: (rows: any[]) => boolean,
): Promise<any[]> {
  const rows: any[] = [];
  for (let from = 0; from < WHY_SCAN_CAP; from += PAGE) {
    const { data, error } = await page(from, Math.min(from + PAGE, WHY_SCAN_CAP) - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;
    rows.push(...data);
    if (data.length < PAGE || done(rows)) break;
  }
  return rows;
}

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const whyKey = (r: { symbol: string; market?: string | null }) => `${r.symbol}:${r.market ?? "us"}`;

/** Per market+symbol key: every stage event of its newest trading chain, its newest research event, and (only when neither exists) its newest decision_observations row. */
async function loadWhyInputs(sb: Sb, keys: string[]) {
  const keySet = new Set(keys);
  const events = new Map<string, Map<number, StageEventRow>>();
  const addEvent = (r: any) => {
    const k = whyKey(r);
    if (!keySet.has(k)) return; // .in("symbol") spans both markets; never cross-match US and India
    const m = events.get(k) ?? new Map<number, StageEventRow>();
    m.set(r.id, r);
    events.set(k, m);
  };
  const newestSignal = new Map<string, string>();
  const bySymbol = [...new Set(keys.map((k) => k.slice(0, k.lastIndexOf(":"))))];

  for (const chunk of chunks(bySymbol, WHY_SYMBOL_CHUNK)) {
    const chunkKeys = keys.filter((k) => chunk.includes(k.slice(0, k.lastIndexOf(":"))));
    const allFound = (rows: any[]) => { const seen = new Set(rows.map(whyKey)); return chunkKeys.every((k) => seen.has(k)); };
    const [tradingRows, researchRows] = await Promise.all([
      scanNewestFirst((from, to) => sb.from("pipeline_stage_events")
        .select("symbol,market,signal_id,created_at")
        .in("stage", [...TRADING_STAGES]).in("symbol", chunk)
        .order("created_at", { ascending: false }).range(from, to), allFound),
      scanNewestFirst((from, to) => sb.from("pipeline_stage_events")
        .select("id,signal_id,symbol,market,stage,outcome,reason,created_at")
        .eq("stage", "research").in("symbol", chunk)
        .order("created_at", { ascending: false }).range(from, to), allFound),
    ]);
    for (const r of tradingRows) {
      const k = whyKey(r);
      if (keySet.has(k) && !newestSignal.has(k) && r.signal_id) newestSignal.set(k, r.signal_id);
    }
    const researched = new Set<string>();
    for (const r of researchRows) {
      const k = whyKey(r);
      if (!researched.has(k)) { researched.add(k); addEvent(r); }
    }
  }

  // Full chain (all trading stages + its research event) for each newest trading signal.
  // 100 signals x ~6 stage rows stays under one 1000-row PostgREST page.
  for (const ids of chunks([...new Set(newestSignal.values())], 100)) {
    const { data, error } = await sb.from("pipeline_stage_events")
      .select("id,signal_id,symbol,market,stage,outcome,reason,detail,created_at")
      .in("signal_id", ids).in("stage", [...TRADING_STAGES, "research"]).limit(PAGE);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) addEvent(r);
  }

  const observations = new Map<string, ObservationRow>();
  const needObs = keys.filter((k) => !events.has(k)).slice(0, WHY_OBS_KEY_CAP);
  for (const group of chunks(needObs, WHY_OBS_CONCURRENCY)) {
    await Promise.all(group.map(async (k) => {
      const symbol = k.slice(0, k.lastIndexOf(":"));
      const market = k.slice(k.lastIndexOf(":") + 1);
      let q = sb.from("decision_observations")
        .select("ts,analyst_score,direction,entry_eligible,score_threshold")
        .eq("symbol", symbol);
      q = market === "us" ? q.or("market.eq.us,market.is.null") : q.eq("market", market);
      const { data, error } = await q.order("ts", { ascending: false }).limit(1);
      if (error) throw new Error(error.message);
      if (data?.[0]) observations.set(k, data[0] as ObservationRow);
    }));
  }

  return {
    eventsFor: (k: string) => [...(events.get(k)?.values() ?? [])],
    observationFor: (k: string) => observations.get(k) ?? null,
  };
}

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
  // Viewer-safe for SCORES and PAPER trades only. This route also reads
  // `broker_orders` — the owner's REAL money orders (side, qty, fill price,
  // status) — which must never reach a viewer, so that query is skipped by role
  // below rather than filtered after the fact.
  const { gate, role } = await requireViewerOrOwner(req);
  if (gate) return gate;
  const isOwner = role === "owner";

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
    isOwner
      ? sb.from("broker_orders")
          .select("id,symbol,market,side,qty,status,created_at,submitted_at,closed_at,avg_fill_price,filled_qty,error")
          .order("created_at", { ascending: false })
          .limit(1000)
      : Promise.resolve({ data: [], error: null } as any),
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
  // Why column explains the PAPER trader only; live orders are out of scope.
  const paperTradeMap = new Map<string, { side: "buy" | "sell"; date: string; reason: string | null }>();
  for (const [key, events] of eventsBySymbol) {
    const paper = latestExecutionEvent(events.filter((e) => e.venue === "paper").sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
    if (paper) paperTradeMap.set(key, { side: paper.side, date: paper.occurred_at, reason: paper.reason });
  }
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

  // Fail-soft: the Why column is an explanation, not the page. A read error
  // leaves trade_why null ("could not load") rather than 500ing the table.
  let why: Awaited<ReturnType<typeof loadWhyInputs>> | null = null;
  try { why = await loadWhyInputs(sb, latest.map(whyKey)); }
  catch (e: any) { console.error("[research/universe] trade_why read failed:", e?.message ?? e); }

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
    trade_why: why ? explainTradeWhy({
      market: r.market ?? "us",
      events: why.eventsFor(whyKey(r)),
      observation: why.observationFor(whyKey(r)),
      lastTrade: paperTradeMap.get(whyKey(r)) ?? null,
    }) : null,
    fundamental_breakdown: breakdownWithStatus(r.fundamental_breakdown, "fundamental", r.market ?? "us"),
    technical_breakdown: breakdownWithStatus(r.technical_breakdown, "technical", r.market ?? "us"),
    sentiment_breakdown: breakdownWithStatus(r.sentiment_breakdown, "sentiment", r.market ?? "us"),
    macro_breakdown: breakdownWithStatus(r.macro_breakdown, "macro", r.market ?? "us"),
  })).sort((a: any, b: any) => (b.analyst_score ?? -Infinity) - (a.analyst_score ?? -Infinity));

  return NextResponse.json({ symbols: out });
}
