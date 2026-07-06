import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaQuote } from "@/lib/india-data";
import { classifyOutcome } from "@/lib/trade-outcome";

// PositionMonitor: daily after-market check for stop-loss hits and price-target hits.
// Uses trailing-stop logic: stop rises with highest_price but never falls below original stop.
// Also honors exit_reason="llm_exit" flags set by LearnerAgent — closes those on next run.
//
// MULTI-MARKET (Phase 4): positions carry a `market` (us | india). US prices come
// from Massive (USD); India prices from free Yahoo .NS (INR). Each position is
// closed against — and credits cash back to — ITS OWN market pool, so currencies
// never cross. Guarded: pre-057 (single pool, no market column) it runs exactly
// as the old US-only path.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const marketOf = (p: any, hasMarketCol: boolean) => (hasMarketCol ? String(p.market ?? "us") : "us");

async function runMonitor(marketScope?: "us" | "india" | null) {
  const svc = createServiceClient();

  // 1. Fetch all paper positions — paper_positions has NO closed_at column
  // (confirmed via information_schema): a position is "open" simply by the
  // row existing; closing means deleting it or reducing qty (see learner
  // route's cutoff-closing logic for the same pattern). The old
  // `.is("closed_at", null)` filter queried a nonexistent column, Supabase
  // returned an error that was never checked, and this route silently did
  // nothing on every single run since — including never refreshing
  // current_price, which is why stale prices lingered for days.
  const { data: allPositionsRaw } = await svc
    .from("paper_positions")
    .select("*");

  // Scope to one market when the caller asks (India cron runs after the NSE close
  // and must only touch India positions, priced off Yahoo; US cron only US).
  const hasMarketColEarly = !!allPositionsRaw?.[0] && Object.prototype.hasOwnProperty.call(allPositionsRaw[0], "market");
  const positions = marketScope && hasMarketColEarly
    ? (allPositionsRaw ?? []).filter((p: any) => String(p.market ?? "us") === marketScope)
    : allPositionsRaw;

  if (!positions?.length) return { checked: 0, closed: 0, closedDetails: [], updated: 0 };

  // Market detection + per-market pools. Post-057 there are 2+ portfolio rows,
  // so `.single()` would THROW — load them all and key by market instead.
  const { data: poolRows } = await svc.from("paper_portfolio").select("*");
  const hasMarketCol = !!poolRows?.[0] && Object.prototype.hasOwnProperty.call(poolRows[0], "market");
  const poolByMarket = new Map<string, any>();
  for (const p of (poolRows ?? []) as any[]) poolByMarket.set(String(p.market ?? "us"), p);
  // Per-market running cash (credited back on close).
  const cashByMarket: Record<string, number> = {};
  for (const [m, p] of poolByMarket) cashByMarket[m] = Number(p.cash_balance ?? (m === "india" ? 1000000 : 10000));

  // 2. Current prices: US via Massive (USD), India via Yahoo .NS (INR).
  const symbols: string[] = Array.from(new Set(positions.map((p: any) => String(p.symbol))));
  const massiveKey = process.env.MASSIVE_API_KEY;
  const priceMap: Record<string, number> = {};
  await Promise.allSettled(
    positions.map(async (pos: any) => {
      const sym = String(pos.symbol);
      if (priceMap[sym] != null) return;
      if (marketOf(pos, hasMarketCol) === "india") {
        const q = await fetchIndiaQuote(sym);
        if (q && q.price > 0) priceMap[sym] = q.price;
        return;
      }
      if (!massiveKey) return;
      try {
        const res = await fetch(`https://api.massive.com/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${massiveKey}`);
        const d = await res.json();
        if (d.results?.[0]?.c) priceMap[sym] = d.results[0].c;
      } catch { /* silently skip unavailable symbols */ }
    })
  );

  // 3b. Daily score-based exit. ResearchAgent re-scores held symbols every
  // trading morning (Mon-Fri); PositionMonitor runs every trading afternoon.
  // So the RIGHT place for "hold while the AI score stays above threshold,
  // exit when it drops below" is HERE, daily — not in LearnerAgent Phase A,
  // which runs weekly (Friday) at best and would leave a decayed position
  // open for days. Fetch the latest analyst_score + direction per held symbol
  // and exit any whose conviction has fallen below the exit threshold.
  // Exit threshold sits below the entry threshold (hysteresis) so a position
  // isn't churned out the moment it dips one point under the buy bar.
  const { data: strategyCfg } = await svc.from("strategy_config").select("score_threshold, min_analyst_score, exit_hysteresis").maybeSingle();
  const entryThreshold = Number((strategyCfg as any)?.score_threshold ?? (strategyCfg as any)?.min_analyst_score ?? 60);
  const hysteresis = Number((strategyCfg as any)?.exit_hysteresis) || 15; // profile-scaled (Part A2); resilient default
  const exitThreshold = Math.max(35, entryThreshold - hysteresis); // e.g. enter 60, exit below 45
  const latestScore: Record<string, { score: number | null; direction: string | null }> = {};
  for (const pos of positions) {
    const sym = String(pos.symbol);
    if (latestScore[sym]) continue;
    let q = svc.from("agent_signals").select("analyst_score, direction").eq("symbol", sym);
    if (hasMarketCol) q = q.eq("market", marketOf(pos, hasMarketCol)); // don't read a US score for an India position
    const { data: sig } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    latestScore[sym] = {
      score: (sig as any)?.analyst_score != null ? Number((sig as any).analyst_score) : null,
      direction: (sig as any)?.direction ?? null,
    };
  }

  const closed: string[] = [];
  const updated: string[] = [];

  // Closing a position = deleting the paper_positions row (it only tracks
  // currently-held qty, no closed/open flag) + marking the matching open
  // paper_trades row(s) closed (those DO have exit_price/realized_pnl/
  // pnl_pct/outcome/closed_at — same pattern learner's cutoff-closing uses;
  // paper_trades, not learning_log, is the real trade-outcome record —
  // learning_log is the learner's own weight-mutation audit log and has no
  // symbol/outcome columns) + crediting cash.
  async function closePosition(pos: any, currentPrice: number, exitReason: string, outcome: string) {
    const market = marketOf(pos, hasMarketCol);
    const cur = market === "india" ? "₹" : "$";
    const realizedPnl = (currentPrice - pos.avg_cost) * pos.qty;
    const pnlPct = pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0;

    // Close each open lot with ITS OWN realized P&L (qty × its own fill_price) —
    // NOT the aggregated position-level figure, which would double-count P&L and
    // mislabel each lot's return when a symbol was accumulated over >1 fill.
    let tq = svc.from("paper_trades").select("id, qty, fill_price").eq("symbol", pos.symbol).is("closed_at", null);
    if (hasMarketCol) tq = tq.eq("market", market);
    const { data: openTrades } = await tq;
    for (const t of openTrades ?? []) {
      const tQty = Number((t as any).qty ?? 0);
      const tFill = Number((t as any).fill_price ?? pos.avg_cost);
      const tPnl = (currentPrice - tFill) * tQty;
      const tPnlPct = tFill > 0 ? ((currentPrice - tFill) / tFill) * 100 : 0;
      const tOutcome = classifyOutcome(tPnlPct);
      await svc.from("paper_trades").update({
        exit_price: currentPrice, realized_pnl: tPnl, pnl_pct: tPnlPct,
        outcome: tOutcome, closed_at: new Date().toISOString(),
      }).eq("id", (t as any).id);
    }

    await svc.from("paper_positions").delete().eq("id", pos.id);

    // Decision Journal was showing "0 entries" because nothing ever wrote to
    // it for exits — only the initial buy fill (paper-trade/route.ts) did.
    // Log the exit so the journal actually reflects the position lifecycle.
    const { error: journalError } = await svc.from("decision_journal").insert({
      entry_type: "paper_exit",
      symbol: pos.symbol,
      summary: `Paper exit (${market.toUpperCase()}): ${pos.qty} × ${pos.symbol} @ ${cur}${currentPrice.toFixed(2)} (${exitReason}), P&L ${cur}${realizedPnl.toFixed(2)} (${outcome})`,
      calculations: { market, qty: pos.qty, exit_price: currentPrice, avg_cost: pos.avg_cost, realized_pnl: realizedPnl, pnl_pct: pnlPct, exit_reason: exitReason },
      has_verified_facts: true,
      has_calculations: true,
      resolved: true,
      resolved_at: new Date().toISOString(),
    });
    if (journalError) console.error("[position-monitor] decision_journal insert failed:", journalError.message);

    cashByMarket[market] = (cashByMarket[market] ?? 0) + currentPrice * pos.qty; // credit THIS market's pool
    closed.push(`${pos.symbol} (${exitReason}: ${cur}${currentPrice.toFixed(2)}, P&L: ${cur}${realizedPnl.toFixed(2)})`);
  }

  for (const pos of positions) {
    const currentPrice = priceMap[pos.symbol];

    // Handle llm_exit flag set by LearnerAgent — close position if flagged and we have a price
    if (pos.exit_reason === "llm_exit" && currentPrice) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      await closePosition(pos, currentPrice, "llm_exit", outcome);
      continue;
    }

    if (!currentPrice) continue;

    // Daily score-based exit: hold while the AI score stays above the exit
    // threshold, exit when today's fresh score drops below it (or the signal
    // flipped away from long). This is the primary conviction-driven exit and
    // runs every trading day — LearnerAgent Phase A's weekly re-score is now a
    // secondary/slower path. Only act when we actually have a recent score;
    // a missing score means research hasn't covered this symbol, so we hold
    // and let the mechanical stop/target below protect it.
    const sc = latestScore[pos.symbol];
    if (sc?.score != null && (sc.score < exitThreshold || (sc.direction && sc.direction !== "long"))) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      await closePosition(pos, currentPrice, `score_exit (${sc.score} < ${exitThreshold})`, outcome);
      continue;
    }

    // Update highest_price (trailing stop anchor)
    const newHighest = Math.max(pos.highest_price ?? pos.avg_cost, currentPrice);

    // Trailing stop: 93% of highest price, but never below original stop_loss
    const trailingStop = Math.max(
      pos.stop_loss ?? (pos.avg_cost * 0.93),
      newHighest * 0.93
    );

    const priceTarget = pos.price_target;

    let exitReason: string | null = null;
    let outcome: string | null = null;

    if (currentPrice <= trailingStop) {
      exitReason = "stop_hit";
      outcome = currentPrice > pos.avg_cost ? "win" : "loss";
    } else if (priceTarget && currentPrice >= priceTarget) {
      exitReason = "target_hit";
      outcome = "win";
    }

    if (exitReason && outcome) {
      await closePosition(pos, currentPrice, exitReason, outcome);
    } else {
      // Still open — refresh current_price + trailing-stop anchor. This is
      // the update that was missing entirely before: current_price never
      // got persisted here, so open positions showed stale entry-day prices
      // indefinitely (e.g. META stuck at its $551 fill price for a week).
      await svc.from("paper_positions").update({
        current_price: currentPrice,
        highest_price: newHighest,
        stop_loss: parseFloat(trailingStop.toFixed(2)),
        updated_at: new Date().toISOString(),
      }).eq("id", pos.id);
      updated.push(pos.symbol);
    }
  }

  // Recompute + persist NAV PER MARKET = that pool's cash + mark-to-market of its
  // still-open positions. Each currency stays in its own pool; never summed.
  const { data: stillOpen } = await svc.from("paper_positions").select("qty, avg_cost, current_price, market");
  for (const [market, pool] of poolByMarket) {
    const mktPos = (stillOpen ?? []).filter((p: any) => marketOf(p, hasMarketCol) === market);
    const positionsValue = mktPos.reduce((sum: number, p: any) => sum + Number(p.qty ?? 0) * Number(p.current_price ?? p.avg_cost ?? 0), 0);
    await svc.from("paper_portfolio").update({
      cash_balance: cashByMarket[market],
      nav: cashByMarket[market] + positionsValue,
      open_positions: mktPos.length,
      updated_at: new Date().toISOString(),
    }).eq("id", pool.id);
  }

  // Bookkeeping row so stale-check (P0 improvement) can tell this ran today and
  // which market — matches the symbols-suffix heuristic research-cron uses.
  try {
    await svc.from("agent_runs").insert({
      agent_type: "position_monitor",
      status: "done",
      symbols: positions.map((p: any) => String(p.symbol)),
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: `Checked ${positions.length}, closed ${closed.length}, updated ${updated.length}.`,
      completed_at: new Date().toISOString(),
    } as any);
  } catch { /* best-effort — never fail the monitor run over bookkeeping */ }

  return {
    checked: positions.length,
    closed: closed.length,
    closedDetails: closed,
    updated: updated.length,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Allow cron calls via x-cron-secret header
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mp = new URL(req.url).searchParams.get("market");
    const result = await runMonitor(mp === "india" ? "india" : mp === "us" ? "us" : null);
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET was unauthenticated and mutated positions/cash on a plain page request —
// anyone (or a crawler/prefetch) hitting this URL could close real positions.
// Require the same auth as POST before running the monitor.
export async function GET(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const mp = new URL(req.url).searchParams.get("market");
    const result = await runMonitor(mp === "india" ? "india" : mp === "us" ? "us" : null);
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
