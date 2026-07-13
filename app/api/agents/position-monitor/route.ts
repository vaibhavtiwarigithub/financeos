import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaQuote } from "@/lib/india-data";
import { classifyOutcome } from "@/lib/trade-outcome";
import { indexClosedTrade } from "@/lib/rag/trade-memory";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadChampionGenome } from "@/lib/validation/genome-live";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { getQuote } from "@/lib/data/quotes";
import { loadTradingMandate, resolveHorizonDays, tradingWeekdaysBetween, type TradingMandate } from "@/lib/trading-mandate";

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
// 120s: the US path (many positions × price fetch + RAG indexing + NAV writes) can
// exceed 60s and get killed mid-run, leaving NO agent_runs row — which made the
// stale-check false-fire "PositionMonitor missed" while the run had actually started.
// pg_net stops waiting at 70s but the function keeps running and writes its own row,
// so a longer ceiling lets a slow run finish and record regardless.
export const maxDuration = 120;

const marketOf = (p: any, hasMarketCol: boolean) => (hasMarketCol ? String(p.market ?? "us") : "us");

// Always leave a trace when a scheduled run throws, so the stale-check sees an
// (errored) run instead of silence, and the real error is captured for diagnosis.
async function logMonitorError(marketScope: "us" | "india" | null, msg: string) {
  try {
    await createServiceClient().from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: "error",
      symbols: [],
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: `PositionMonitor failed: ${msg}`.slice(0, 500),
      completed_at: new Date().toISOString(),
    } as any);
  } catch { /* never mask the original error */ }
}

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
  const { data: allPositionsRaw, error: positionsError } = await svc
    .from("paper_positions")
    .select("*");
  if (positionsError) throw new Error(`paper_positions read failed: ${positionsError.message}`);

  // Scope to one market when the caller asks (India cron runs after the NSE close
  // and must only touch India positions, priced off Yahoo; US cron only US).
  const hasMarketColEarly = !!allPositionsRaw?.[0] && Object.prototype.hasOwnProperty.call(allPositionsRaw[0], "market");
  const positions = marketScope && hasMarketColEarly
    ? (allPositionsRaw ?? []).filter((p: any) => String(p.market ?? "us") === marketScope)
    : allPositionsRaw;

  if (!positions?.length) {
    // Still write bookkeeping so stale-check knows PM fired today for this market.
    await svc.from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: "done",
      symbols: [],
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: "No open positions for this market.",
      completed_at: new Date().toISOString(),
    } as any).catch(() => {});
    return { checked: 0, closed: 0, closedDetails: [], updated: 0 };
  }

  // Market detection + per-market pools. Post-057 there are 2+ portfolio rows,
  // so `.single()` would THROW — load them all and key by market instead.
  const { data: poolRows, error: poolError } = await svc.from("paper_portfolio").select("*");
  if (poolError) throw new Error(`paper_portfolio read failed: ${poolError.message}`);
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
  // Load champion genome per market — provides horizon_days for time stop.
  // Falls back to DEFAULT_GENOME (horizon 10d) when no champion exists.
  const activeMarkets = Array.from(new Set(positions.map((p: any) => marketOf(p, hasMarketCol)))) as ("us" | "india")[];

  // User's Trading Style horizon preference (strategy_config.target_hold_days).
  // This is a DEFAULT that only applies while no promoted champion governs the
  // horizon — once the LearnerAgent promotes a champion, its learned
  // genome.horizon_days wins and this is ignored (we never fight the learner).
  // Best-effort read: pre-167 the column doesn't exist, so a query error simply
  // leaves the genome in charge.
  const horizonDaysByMarket = new Map<string, number>();
  const mandateByMarket = new Map<string, TradingMandate>();
  await Promise.allSettled(activeMarkets.map(async (m) => {
    try {
      const g = await loadChampionGenome(svc, m);
      const mandate = await loadTradingMandate(svc, m);
      mandateByMarket.set(m, mandate);
      // Champion promoted → learned horizon wins (don't fight the learner).
      // No champion (source "default") → prefer the user's Trading Style
      // target_hold_days, falling back to DEFAULT_GENOME horizon (10) when unset.
      horizonDaysByMarket.set(m, resolveHorizonDays(mandate, g.source === "champion" ? g.genome.horizon_days : null).days);
    } catch {
      const mandate = await loadTradingMandate(svc, m);
      mandateByMarket.set(m, mandate);
      horizonDaysByMarket.set(m, mandate.target_hold_days);
    }
  }));

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
        outcome: tOutcome, exit_reason: exitReason, closed_at: new Date().toISOString(),
      }).eq("id", (t as any).id);
      // Index this now-closed trade into the RAG memory corpus (Tier-3 #10).
      // Best-effort: no-op when embeddings are off; a failure never blocks the exit.
      await indexClosedTrade(String((t as any).id)).catch(() => {});
    }

    await svc.from("paper_positions").delete().eq("id", pos.id);

    // Decision Journal was showing "0 entries" because nothing ever wrote to
    // it for exits — only the initial buy fill (paper-trade/route.ts) did.
    // Log the exit so the journal actually reflects the position lifecycle.
    const { error: journalError } = await svc.from("decision_journal").insert({
      entry_type: "paper_exit",
      symbol: pos.symbol,
      market,
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
    const market = marketOf(pos, hasMarketCol);

    // Handle llm_exit flag set by LearnerAgent — close position if flagged and we have a price
    if (pos.exit_reason === "llm_exit" && currentPrice) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      await closePosition(pos, currentPrice, "llm_exit", outcome);
      continue;
    }

    if (!currentPrice) continue;

    // Time stop: close if position age exceeds champion genome's horizon_days.
    // Closes slow bleeds that never hit the hard stop but overstay the swing window.
    // Matches the backtest's max_hold_days assumption so live and backtest are consistent.
    if (pos.created_at) {
      const mandate = mandateByMarket.get(market);
      const storedHorizon = Number(pos.resolved_horizon_days);
      const grandfathered = mandate?.existing_positions_policy !== "apply" && Number.isFinite(storedHorizon) && storedHorizon >= 2;
      const horizonDays = grandfathered ? storedHorizon : (horizonDaysByMarket.get(market) ?? 10);
      const ageDays = tradingWeekdaysBetween(new Date(pos.created_at), new Date());
      if (ageDays > horizonDays) {
        const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
        await closePosition(pos, currentPrice, `time_stop (${ageDays} market days > ${horizonDays}d${grandfathered ? ", grandfathered" : ""})`, outcome);
        continue;
      }
    }

    // Daily score-based exit: hold while the AI score stays above the exit
    // threshold, exit when today's fresh score drops below it (or the signal
    // flipped away from long). This is the primary conviction-driven exit and
    // runs every trading day — LearnerAgent Phase A's weekly re-score is now a
    // secondary/slower path. Only act when we actually have a recent score;
    // a missing score means research hasn't covered this symbol, so we hold
    // and let the mechanical stop/target below protect it.
    const sc = latestScore[pos.symbol];
    // Two DISTINCT exit conditions share this branch; label them separately with
    // structured reason codes so the trade record isn't mislabeled. A direction
    // flip (held long, fresh signal now points away) is NOT a score comparison —
    // emitting "68 < 37" for a flip is nonsense. Direction flip takes precedence.
    const scoreBelowExit = sc?.score != null && sc.score < exitThreshold;
    const directionFlipped = !!(sc?.direction && sc.direction !== "long");
    if (sc?.score != null && (scoreBelowExit || directionFlipped)) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      // closePosition takes a string reason; prefix with a machine-readable code.
      const exitReason = directionFlipped
        ? `direction_flip (was long, now ${sc.direction})`
        : `score_below_exit_threshold (${sc.score} < ${exitThreshold})`;
      await closePosition(pos, currentPrice, exitReason, outcome);
      continue;
    }

    // Update highest_price (trailing stop anchor)
    const newHighest = Math.max(pos.highest_price ?? pos.avg_cost, currentPrice);

    // Trail at the position's OWN stop distance (the MAE-derived stop
    // PaperTrader set at fill, preserved immutably as initial_stop_loss), not a
    // hardcoded 7%. A volatile name whose initial stop sat 12% below cost keeps
    // a 12% trail; a tight 4% stop trails 4%. This stops the fixed-7% trail from
    // silently overwriting Phase 2 dynamic R:R. Clamp guards a bad anchor.
    const anchorPct = pos.initial_stop_loss != null && pos.avg_cost > 0
      ? Math.min(0.99, Math.max(0.5, pos.initial_stop_loss / pos.avg_cost))
      : 0.93;

    // Trailing stop: anchorPct of highest price, but never below original stop_loss
    const trailingStop = Math.max(
      pos.stop_loss ?? (pos.avg_cost * anchorPct),
      newHighest * anchorPct
    );

    const priceTarget = pos.price_target;

    let exitReason: string | null = null;
    let outcome: string | null = null;

    if (currentPrice <= trailingStop) {
      exitReason = "stop_hit";
      outcome = currentPrice > pos.avg_cost ? "win" : "loss";
    } else if (priceTarget && currentPrice >= priceTarget) {
      // Partial profit-taking: close half at target, move stop to breakeven on remainder.
      // Only split if qty >= 2 — a single share must fully close.
      const halfQty = Math.floor(pos.qty / 2);
      if (halfQty >= 1) {
        const remainQty = pos.qty - halfQty;
        const proceeds = halfQty * currentPrice;
        cashByMarket[market] = (cashByMarket[market] ?? 0) + proceeds;
        await svc.from("paper_positions").update({
          qty: remainQty,
          stop_loss: parseFloat(Number(pos.avg_cost).toFixed(2)),
          price_target: null,
          current_price: currentPrice,
          highest_price: Math.max(pos.highest_price ?? pos.avg_cost, currentPrice),
          updated_at: new Date().toISOString(),
        }).eq("id", pos.id);
        // Close open trade lots FIFO proportionally.
        let remainToClose = halfQty;
        let lotQ = svc.from("paper_trades").select("id, qty, fill_price, executed_at").eq("symbol", pos.symbol).is("closed_at", null).order("executed_at", { ascending: true });
        if (hasMarketCol) lotQ = lotQ.eq("market", market);
        const { data: openLots } = await lotQ;
        for (const lot of openLots ?? []) {
          if (remainToClose <= 0) break;
          const lotQty = Number((lot as any).qty ?? 0);
          const closeQty = Math.min(lotQty, remainToClose);
          const lotFill = Number((lot as any).fill_price ?? pos.avg_cost);
          const lotPnlPct = lotFill > 0 ? ((currentPrice - lotFill) / lotFill) * 100 : 0;
          if (closeQty < lotQty) {
            await svc.from("paper_trades").update({ qty: lotQty - closeQty }).eq("id", (lot as any).id);
          } else {
            await svc.from("paper_trades").update({
              exit_price: currentPrice, realized_pnl: (currentPrice - lotFill) * closeQty,
              pnl_pct: lotPnlPct, outcome: "win", exit_reason: "partial_target",
              closed_at: new Date().toISOString(),
            }).eq("id", (lot as any).id);
          }
          remainToClose -= closeQty;
        }
        await svc.from("decision_journal").insert({
          entry_type: "paper_exit", symbol: pos.symbol, market,
          summary: `Partial exit: closed ${halfQty}/${pos.qty} × ${pos.symbol} @ ${currentPrice.toFixed(2)} (target). Remaining ${remainQty} shares, stop moved to breakeven.`,
          calculations: { halfQty, remainQty, exit_price: currentPrice, avg_cost: pos.avg_cost, exit_reason: "partial_target" },
          has_verified_facts: true, has_calculations: true, resolved: true, resolved_at: new Date().toISOString(),
        }).catch(() => {});
        updated.push(`${pos.symbol} (partial_target: ${halfQty}/${pos.qty} closed, stop→breakeven)`);
        continue;
      }
      // qty == 1 — can't split
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
  const today = new Date().toISOString().slice(0, 10);
  // Track NAV/performance write failures (P0-4): a rejected update must fail the
  // run visibly, not be swallowed. Also track NAV-invariant drift (read-only).
  const navWriteErrors: string[] = [];
  let navInvariantOk = true;
  const navInvariantDrift: Record<string, number> = {};
  for (const [market, pool] of poolByMarket) {
    const mktPos = (stillOpen ?? []).filter((p: any) => marketOf(p, hasMarketCol) === market);
    const positionsValue = mktPos.reduce((sum: number, p: any) => sum + Number(p.qty ?? 0) * Number(p.current_price ?? p.avg_cost ?? 0), 0);
    const newNav = cashByMarket[market] + positionsValue;

    // Deterministic NAV invariant (read-only): nav must equal cash + mark-to-market
    // of this market's open lots within a currency-cent tolerance. If a future
    // refactor breaks that identity, this makes the drift observable WITHOUT
    // mutating any data. ₹ and $ both carry two decimals, so a 1-cent base
    // tolerance plus a tiny relative term absorbs float-summation rounding.
    const invariantExpected = cashByMarket[market] + mktPos.reduce(
      (sum: number, p: any) => sum + Number(p.qty ?? 0) * Number(p.current_price ?? p.avg_cost ?? 0), 0);
    const invariantEps = Math.max(0.01, Math.abs(newNav) * 1e-6);
    const invariantDiff = Math.abs(newNav - invariantExpected);
    if (invariantDiff > invariantEps) {
      navInvariantOk = false;
      navInvariantDrift[market] = invariantDiff;
      console.warn(
        `[position-monitor] NAV invariant violation (${market}): nav=${newNav} != cash(${cashByMarket[market]}) + positions(${invariantExpected - cashByMarket[market]}) — drift ${invariantDiff.toFixed(4)} > eps ${invariantEps.toFixed(4)}`,
      );
    }

    // `open_positions` was removed: the column does NOT exist on deployed
    // paper_portfolio, so naming it made PostgREST reject the WHOLE update and the
    // ignored error silently corrupted NAV. Nothing reads paper_portfolio.open_positions
    // (the performance route reads it from paper_nav_history). Capture the error now.
    const { error: portfolioErr } = await svc.from("paper_portfolio").update({
      cash_balance: cashByMarket[market],
      nav: newNav,
      updated_at: new Date().toISOString(),
    }).eq("id", pool.id);
    if (portfolioErr) navWriteErrors.push(`paper_portfolio(${market}): ${portfolioErr.message}`);

    // Ledger reconciliation guard: cash MUST equal seed − Σopen-cost + Σrealized.
    // A drift means a cash write was silently lost (this is exactly how the old
    // open_positions-column bug leaked ₹197k of close-proceeds and tripped a
    // PHANTOM drawdown). Surface it as its own alert BEFORE the drawdown breaker
    // acts on a corrupted NAV — never silently trip the kill switch on bad math.
    try {
      const seed = market === "india" ? 1_000_000 : 10_000;
      const openCost = mktPos.reduce(
        (s: number, p: any) => s + Number(p.qty ?? 0) * Number(p.avg_cost ?? 0), 0);
      const { data: realizedRows } = await svc.from("paper_trades")
        .select("realized_pnl").eq("market", market).not("closed_at", "is", null);
      const realized = (realizedRows ?? []).reduce(
        (s: number, r: any) => s + Number(r.realized_pnl ?? 0), 0);
      const ledgerCash = seed - openCost + realized;
      const drift = Math.abs(cashByMarket[market] - ledgerCash);
      const tol = Math.max(1, seed * 0.005); // 0.5% of seed
      if (drift > tol) {
        await reportIssue({
          issueKey: `paper-cash-drift:${market}`,
          severity: "warn", category: "risk",
          title: `Paper cash ledger drift — ${market.toUpperCase()} (${drift.toFixed(0)})`,
          detail: `cash_balance ${cashByMarket[market].toFixed(0)} != ledger ${ledgerCash.toFixed(0)} (seed − open-cost + realized). A close-proceeds write was likely lost — reconcile before trusting NAV/drawdown; the drawdown breaker may be acting on a phantom NAV.`,
        }, svc);
      } else {
        await resolveIssue(`paper-cash-drift:${market}`, svc);
      }
    } catch { /* guard is advisory — never block the monitor */ }

    // C: Benchmark price daily sync — fetch VOO (US) or ^NSEI (India) and upsert
    // paper_performance so bench_nav stays current even on no-trade days.
    let benchNav: number | null = null;
    let benchReturnPct: number | null = null;
    let alphaPct: number | null = null;
    try {
      const benchSym = market === "india" ? "^NSEI" : "VOO";
      const q = market === "india"
        ? await fetchIndiaQuote(benchSym)
        : await getQuote(benchSym, svc);
      const px = (q as any)?.price;
      benchNav = typeof px === "number" && px > 0 ? px : null;
      if (benchNav) {
        const { data: firstPerf } = await svc.from("paper_performance")
          .select("bench_nav").eq("market", market).not("bench_nav", "is", null)
          .order("date", { ascending: true }).limit(1).maybeSingle();
        const { data: startPerfRow } = await svc.from("paper_performance")
          .select("nav").eq("market", market).order("date", { ascending: true }).limit(1).maybeSingle();
        const benchStart = (firstPerf as any)?.bench_nav ?? benchNav;
        benchReturnPct = benchStart ? ((benchNav - benchStart) / benchStart) * 100 : null;
        const startNav = Number((startPerfRow as any)?.nav ?? newNav);
        const portfolioReturnPct = startNav > 0 ? ((newNav - startNav) / startNav) * 100 : 0;
        alphaPct = benchReturnPct != null ? portfolioReturnPct - benchReturnPct : null;
      }
    } catch { /* benchmark unavailable this run — leave null */ }

    const perfRow: Record<string, any> = {
      date: today, market, nav: newNav,
      cash_balance: cashByMarket[market], positions_value: positionsValue,
      bench_nav: benchNav, bench_return_pct: benchReturnPct, alpha_pct: alphaPct,
      spy_nav: market === "us" ? benchNav : null,
      spy_return_pct: market === "us" ? benchReturnPct : null,
      updated_at: new Date().toISOString(),
    };
    // PostgREST returns { error } rather than throwing, so the old `.catch` never
    // fired on a real write failure. Capture the error; on the pre-057 "no market
    // column" case, retry keyed on date only (preserving prior fallback behavior);
    // any surviving error fails the run visibly.
    const { error: perfErr } = await svc.from("paper_performance").upsert(perfRow, { onConflict: "date,market" });
    if (perfErr) {
      const { error: perfErr2 } = await svc.from("paper_performance").upsert({ ...perfRow, market: undefined }, { onConflict: "date" });
      if (perfErr2) navWriteErrors.push(`paper_performance(${market}): ${perfErr2.message}`);
    }

    // A: Portfolio NAV drawdown circuit breaker.
    // If this market's NAV has dropped > 5% vs its value 7 calendar days ago,
    // auto-pause new entries and surface a System Health alert.
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: oldPerf } = await svc.from("paper_performance")
        .select("nav").eq("market", market)
        .lte("date", sevenDaysAgo).order("date", { ascending: false }).limit(1).maybeSingle();
      const oldNav = Number((oldPerf as any)?.nav ?? 0);
      const issueKey = `nav-drawdown:${market}`;
      if (oldNav > 0) {
        const weeklyReturn = (newNav - oldNav) / oldNav;
        if (weeklyReturn < -0.05) {
          await svc.from("strategy_config").update({ app_paused: true }).not("id", "is", null);
          await reportIssue({
            issueKey,
            severity: "critical",
            category: "risk",
            title: `NAV drawdown circuit breaker — ${market.toUpperCase()} (${(weeklyReturn * 100).toFixed(1)}% / 7d)`,
            detail: `Weekly NAV dropped ${(weeklyReturn * 100).toFixed(1)}% (from ${oldNav.toFixed(0)} to ${newNav.toFixed(0)}). New entries auto-paused. Manually resume in Settings once you've reviewed open positions.`,
          });
        } else {
          await resolveIssue(issueKey);
        }
      }
    } catch { /* best-effort — never block the monitor run */ }
  }

  // Bookkeeping row so stale-check (P0 improvement) can tell this ran today and
  // which market — matches the symbols-suffix heuristic research-cron uses.
  // A NAV/performance write failure marks the run "error" (not "done") so the
  // failure is visible instead of silently swallowed (P0-4).
  const navWriteFailed = navWriteErrors.length > 0;
  const navAlertKey = `position-monitor-nav-write:${marketScope ?? "us"}`;
  try {
    await svc.from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: navWriteFailed ? "error" : "done",
      symbols: positions.map((p: any) => String(p.symbol)),
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: navWriteFailed
        ? `NAV/performance write FAILED: ${navWriteErrors.join("; ")}`.slice(0, 500)
        : `Checked ${positions.length}, closed ${closed.length}, updated ${updated.length}.`,
      completed_at: new Date().toISOString(),
    } as any);
  } catch { /* best-effort — never fail the monitor run over bookkeeping */ }

  // Surface (or clear) a System Health alert for the NAV write path.
  if (navWriteFailed) {
    await reportIssue({
      issueKey: navAlertKey,
      severity: "critical",
      category: "paper-truth",
      title: `PositionMonitor NAV/performance write failed — ${(marketScope ?? "us").toUpperCase()}`,
      detail: `Paper NAV/performance ledger write was rejected and NAV may be stale: ${navWriteErrors.join("; ")}`.slice(0, 500),
    });
  } else {
    await resolveIssue(navAlertKey);
  }

  return {
    checked: positions.length,
    closed: closed.length,
    closedDetails: closed,
    updated: updated.length,
    nav_write_ok: !navWriteFailed,
    nav_write_errors: navWriteErrors,
    nav_invariant_ok: navInvariantOk,
    nav_invariant_drift: navInvariantDrift,
  };
}

export async function POST(req: NextRequest) {
  try {
    // Allow cron calls via x-cron-secret header
    const isCron = verifyCronSecret(req);

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const mp = new URL(req.url).searchParams.get("market");
    const scope = mp === "india" ? "india" : mp === "us" ? "us" : null;
    try {
      const result = await runMonitor(scope);
      return NextResponse.json({ success: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await logMonitorError(scope, msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// GET was unauthenticated and mutated positions/cash on a plain page request —
// anyone (or a crawler/prefetch) hitting this URL could close real positions.
// Require the same auth as POST before running the monitor.
export async function GET(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const mp = new URL(req.url).searchParams.get("market");
  const scope = mp === "india" ? "india" : mp === "us" ? "us" : null;
  try {
    const result = await runMonitor(scope);
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await logMonitorError(scope, msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
