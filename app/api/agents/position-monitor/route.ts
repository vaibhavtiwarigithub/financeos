import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchIndiaQuotes, fetchYahooQuotes } from "@/lib/india-data";
import { classifyOutcome } from "@/lib/trade-outcome";
import { indexClosedTrade } from "@/lib/rag/trade-memory";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadChampionGenome } from "@/lib/validation/genome-live";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { runAccountingEnvelope } from "@/lib/monitoring/run-accounting";
import { setMarketPaused } from "@/lib/market-controls";
import { computeExitFillPrice, getSettledDailyQuotes } from "@/lib/data/quotes";
import { expectedNewestSession } from "@/lib/data/completed-candles";
import { loadTradingMandate, resolveHorizonDays, tradingWeekdaysBetween, type TradingMandate } from "@/lib/trading-mandate";
import { isPaperScoreFresh, marketSessionsSince, paperPositionOpenedAt, resolvePaperExitThreshold } from "@/lib/trading/paper-exit-policy";
import { paperPerformanceTruth, resolvedPaperOutcomeCount } from "@/lib/paper-nav";
import { decideDirectionFlip, armedFlag, parseArmedSession, MIN_FLIP_HOLD_DAYS } from "@/lib/trading/direction-flip";
import { paperPartialTargetQuantity } from "@/lib/trading/paper-quantity";
import { admitMarketLocalSlot } from "@/lib/trading/market-calendar";
import {
  buildPositionMark, markLedgerRow, navFromMarks, reconcilePersistedNav, summariseMarkCoverage,
  type PositionMark,
} from "@/lib/paper/marks";
import { benchmarkReturnPct, fetchBenchmarkObservation } from "@/lib/paper/benchmark-observation";

// PositionMonitor: daily after-market check for stop-loss hits and price-target hits.
// Uses trailing-stop logic: stop rises with highest_price but never falls below original stop.
// Legacy exit_reason="llm_exit" rows are revalidated deterministically before draining.
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

// Provenance of a quote accepted this run, kept alongside the bare price so the
// NAV mark it produces can be attributed afterwards. Before W4 only the number
// survived, which is why the 2026-08-12 NAV round trip is unexplainable.
type QuoteProvenance = { source: string; observedAt: string | null };

// PostgREST reports an unknown column as PGRST204 and an unknown relation as
// 42P01. Both mean "the migration for this hasn't been applied yet", and both
// must leave the money path running rather than failing the whole book run.
const isMissingSchema = (err: any) =>
  err?.code === "PGRST204" || err?.code === "42P01" ||
  /column .* does not exist|could not find the .* column|relation .* does not exist/i.test(String(err?.message ?? ""));

// Always leave a trace when a scheduled run throws, so the stale-check sees an
// (errored) run instead of silence, and the real error is captured for diagnosis.
async function logMonitorError(marketScope: "us" | "india" | null, msg: string, startedAt: string) {
  try {
    await createServiceClient().from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: "error",
      symbols: [],
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: `PositionMonitor failed: ${msg}`.slice(0, 500),
      started_at: startedAt,
      completed_at: new Date().toISOString(),
    } as any);
  } catch { /* never mask the original error */ }
}

async function runMonitor(marketScope: "us" | "india" | null | undefined, startedAt: string) {
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
    if (marketScope) await resolveIssue(`position-monitor-price-unavailable:${marketScope}`, svc);
    // Still write bookkeeping so stale-check knows PM fired today for this market.
    await svc.from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: "done",
      symbols: [],
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: "No open positions for this market.",
      started_at: startedAt,
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
  const priceMap: Record<string, number> = {};
  const usSymbols = [...new Set<string>(positions
    .filter((p: any) => marketOf(p, hasMarketCol) === "us")
    .map((p: any): string => String(p.symbol)))];
  const indiaSymbols = [...new Set<string>(positions
    .filter((p: any) => marketOf(p, hasMarketCol) === "india")
    .map((p: any): string => String(p.symbol)))];
  // US: settled daily bars, not the snapshot batch. The deployed Massive key is
  // 403 NOT_AUTHORIZED for every /v2/snapshot endpoint, so `getBatchQuotes`
  // resolved ZERO US symbols and the book fell through to a stale price_cache
  // bar. On 2026-08-17 that marked all 13 holdings at Friday's prices: NAV was
  // overstated by $57.79, flipping the reported US result from +0.24% to -0.34%,
  // and per-name drift reached 3.92% against a 7% stop. This monitor runs after
  // the close, so the settled session bar is the correct price anyway — and the
  // grouped feed carries OHLC, so `dayLow` for the intraday-stop check survives.
  const [usQuotes, indiaQuotes] = await Promise.all([
    getSettledDailyQuotes(usSymbols, svc, "us"),
    fetchIndiaQuotes(indiaSymbols),
  ]);
  // dayLowMap: session low from Massive snapshot. Used to detect intraday stop
  // touches — a stop hit during the session is real even if price recovered by close.
  const dayLowMap: Record<string, number> = {};
  // W4: keep the accepted quote's source and its OWN observation time, not just
  // the price. Every mark written below is attributable because of this map.
  const quoteMeta: Record<string, QuoteProvenance> = {};
  for (const sym of usSymbols) {
    const q = usQuotes[sym];
    if (q && q.source !== "unavailable" && !q.stale && q.price > 0) {
      priceMap[sym] = q.price;
      quoteMeta[sym] = { source: q.source, observedAt: q.retrievedAt ?? null };
    }
    if (q?.dayLow != null && q.dayLow > 0) dayLowMap[sym] = q.dayLow;
  }
  for (const sym of indiaSymbols) {
    const q = indiaQuotes[sym.toUpperCase()];
    if (q && !q.stale && q.price > 0) {
      priceMap[sym] = q.price;
      quoteMeta[sym] = { source: "yahoo_india", observedAt: q.retrievedAt ?? null };
    }
  }
  // Massive/cache/AV occasionally miss an otherwise liquid US holding. Exhaust
  // one independent, keyless source for only that unresolved tail. Yahoo remains
  // a fallback (never the primary batch), and its US freshness policy rejects a
  // multi-day close so exit decisions still fail closed.
  const unresolvedUs = usSymbols.filter(sym => priceMap[sym] == null);
  if (unresolvedUs.length > 0) {
    const yahooQuotes = await fetchYahooQuotes(unresolvedUs, "us");
    for (const sym of unresolvedUs) {
      const q = yahooQuotes[sym.toUpperCase()];
      if (q && !q.stale && q.price > 0) {
        priceMap[sym] = q.price;
        quoteMeta[sym] = { source: "yahoo_us", observedAt: q.retrievedAt ?? null };
      }
    }
  }
  const unpricedByMarket: Record<"us" | "india", string[]> = {
    us: usSymbols.filter(sym => priceMap[sym] == null),
    india: indiaSymbols.filter(sym => priceMap[sym] == null),
  };
  const monitoredMarkets: Array<"us" | "india"> = marketScope ? [marketScope] : ["us", "india"];
  for (const market of monitoredMarkets) {
    const issueKey = `position-monitor-price-unavailable:${market}`;
    if (unpricedByMarket[market].length > 0) {
      await reportIssue({
        issueKey,
        severity: "warn",
        category: "data",
        title: `PositionMonitor could not price ${unpricedByMarket[market].length} ${market.toUpperCase()} holding(s)`,
        detail: `No stop, target, time-stop, or conviction exit was evaluated for: ${unpricedByMarket[market].join(", ")}. Other positions with valid quotes were still evaluated.`,
        autoExpireAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }, svc);
    } else {
      await resolveIssue(issueKey, svc);
    }
  }

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

  const { data: strategyCfg } = await svc.from("strategy_config").select("exit_hysteresis").maybeSingle();
  const hysteresis = Number((strategyCfg as any)?.exit_hysteresis) || 15; // profile-scaled (Part A2); resilient default
  const latestScore: Record<string, { score: number | null; direction: string | null; createdAt: string | null; isHolding: boolean }> = {};
  for (const pos of positions) {
    if (pos.position_role === "hedge") continue;
    const sym = String(pos.symbol);
    const scoreMarket = marketOf(pos, hasMarketCol) as "us" | "india";
    const scoreKey = `${scoreMarket}:${sym}`;
    if (latestScore[scoreKey]) continue;
    let q = svc.from("agent_signals").select("analyst_score, direction, created_at, is_holding")
      .eq("symbol", sym).eq("score_source", "deterministic_v1")
      // Weekend-staged scores cannot force a conviction exit. Mechanical
      // stop/target/time exits below remain independent and continue normally.
      .eq("session_validated", true);
    if (hasMarketCol) q = q.eq("market", scoreMarket); // don't read a US score for an India position
    const { data: sig } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    latestScore[scoreKey] = {
      score: (sig as any)?.analyst_score != null ? Number((sig as any).analyst_score) : null,
      direction: (sig as any)?.direction ?? null,
      createdAt: (sig as any)?.created_at ?? null,
      isHolding: (sig as any)?.is_holding === true,
    };
  }

  const closed: string[] = [];
  const updated: string[] = [];
  const staleScoresHeld: string[] = [];

  // Closing a position = deleting the paper_positions row (it only tracks
  // currently-held qty, no closed/open flag) + marking the matching open
  // paper_trades row(s) closed (those DO have exit_price/realized_pnl/
  // pnl_pct/outcome/closed_at — same pattern learner's cutoff-closing uses;
  // paper_trades, not learning_log, is the real trade-outcome record —
  // learning_log is the learner's own weight-mutation audit log and has no
  // symbol/outcome columns) + crediting cash.
  async function closePosition(
    pos: any,
    currentPrice: number,
    exitReason: string,
    _outcome: string,
    exitQty?: number,
    partialStopLoss?: number,
  ) {
    const market = marketOf(pos, hasMarketCol);
    const cur = market === "india" ? "₹" : "$";
    const exitFillPrice = computeExitFillPrice(currentPrice);
    const requestedQty = exitQty ?? Number(pos.qty);
    const { data, error } = await svc.rpc("execute_paper_exit", {
      p_position_id: pos.id,
      p_exit_price: exitFillPrice,
      p_exit_reason: exitReason,
      p_exit_qty: requestedQty,
      p_partial_stop_loss: partialStopLoss ?? null,
    });
    if (error) throw new Error(`execute_paper_exit failed (${pos.symbol}): ${error.message}`);
    const result = data as any;
    if (!result?.ok) throw new Error(`execute_paper_exit denied (${pos.symbol}): ${result?.error ?? "unknown"}`);

    for (const tradeId of result.closed_trade_ids ?? []) {
      await indexClosedTrade(String(tradeId)).catch(() => {});
    }

    if (pos.position_role === "hedge") {
      const { error } = await svc.rpc("complete_paper_hedge_exit", { p_symbol: pos.symbol, p_reason: exitReason });
      if (error) {
        await reportIssue({
          issueKey: "downside-hedge-state-reconcile",
          severity: "warn", category: "risk",
          title: "Paper hedge closed but controller state needs reconciliation",
          detail: `The ${pos.symbol} paper position closed, but cooldown state could not be recorded: ${error.message}. The hedge controller will reconcile before another entry.`,
        }, svc);
      } else {
        await resolveIssue("downside-hedge-state-reconcile", svc);
      }
    }

    cashByMarket[market] = (cashByMarket[market] ?? 0) + Number(result.proceeds ?? 0);
    if (Number(result.remaining_qty ?? 0) > 0) {
      updated.push(`${pos.symbol} (partial_target: ${requestedQty}/${pos.qty} closed, stop→breakeven)`);
    } else {
      closed.push(`${pos.symbol} (${exitReason}: ${cur}${exitFillPrice.toFixed(2)}, P&L: ${cur}${Number(result.realized_pnl ?? 0).toFixed(2)})`);
    }
  }

  // Per-position isolation (2026-08-18). A single position's exit failure MUST
  // NOT abort the run.
  //
  // Production: on 2026-08-18 20:15 `execute_paper_exit denied (MSFT):
  // position_lot_qty_mismatch` threw out of this loop and killed the whole run —
  // no marks, no NAV, and the other 12 US positions never evaluated. The
  // 2026-08-14 run died the same way on LNC (`existing_open_position`). One
  // symbol's data defect blanking the entire book's monitoring is a far worse
  // outcome than that symbol going unevaluated.
  //
  // The RPC denial itself is CORRECT and stays: MSFT's only lot closed on
  // 2026-08-03 while its paper_positions row survived, so the parity check
  // refuses to close 0.472499 that no open lot backs. Suppressing the guard
  // would double-count a realized trade. We isolate the failure, not silence it:
  // it is recorded, alerted, and counted as a `failed` unit in the W6 envelope,
  // which marks the run `error` while still letting it finish its other work.
  const exitFailures: Array<{ symbol: string; market: string; reason: string }> = [];
  for (const pos of positions) {
   try {
    const currentPrice = priceMap[pos.symbol];
    const market = marketOf(pos, hasMarketCol) as "us" | "india";
    const sc = latestScore[`${market}:${String(pos.symbol)}`];
    const mandate = mandateByMarket.get(market);
    const entryThreshold = mandate?.score_threshold ?? 60;
    const exitThreshold = resolvePaperExitThreshold(entryThreshold, hysteresis);
    const maxScoreAge = mandate?.max_signal_age_sessions ?? 2;
    const scoreFresh = isPaperScoreFresh(sc?.createdAt, new Date(), market, maxScoreAge);

    // Handle reassess-exit flag set by LearnerAgent — close position if flagged and
    // we have a price. "score_reassess_exit" is the current (deterministic,
    // score-based) flag; "llm_exit" is honored only to drain any legacy rows
    // flagged before the LLM-discretion exit path was removed (2026-07-15).
    if (pos.position_role === "hedge" && pos.exit_reason === "hedge_exit" && currentPrice) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      await closePosition(pos, currentPrice, "hedge_exit", outcome);
      continue;
    }
    if (pos.position_role !== "hedge" && (pos.exit_reason === "score_reassess_exit" || pos.exit_reason === "llm_exit") && currentPrice) {
      if (scoreFresh && sc?.score != null && sc.score < exitThreshold) {
        const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
        await closePosition(pos, currentPrice, `score_reassess_exit (${sc.score} < ${exitThreshold})`, outcome);
        continue;
      }
      await svc.from("paper_positions").update({ exit_reason: null, updated_at: new Date().toISOString() }).eq("id", pos.id);
      staleScoresHeld.push(`${pos.symbol} (flag cleared: ${scoreFresh ? "latest score no longer below exit threshold" : "score stale/unavailable"})`);
    }

    if (!currentPrice) continue;

    // Time stop: close if position age exceeds champion genome's horizon_days.
    // Closes slow bleeds that never hit the hard stop but overstay the swing window.
    // Matches the backtest's max_hold_days assumption so live and backtest are consistent.
    const openedAt = paperPositionOpenedAt(pos);
    // Market days held — shared by the time stop and the direction-flip min-hold
    // floor. null when the open time is unknown (fail-open: never blocks a flip).
    const ageDays = openedAt ? tradingWeekdaysBetween(new Date(openedAt), new Date()) : null;
    if (openedAt && ageDays != null) {
      const mandate = mandateByMarket.get(market);
      const storedHorizon = Number(pos.resolved_horizon_days);
      const grandfathered = mandate?.existing_positions_policy !== "apply" && Number.isFinite(storedHorizon) && storedHorizon >= 2;
      const horizonDays = pos.position_role === "hedge"
        ? (Number.isFinite(storedHorizon) && storedHorizon >= 1 ? storedHorizon : 5)
        : grandfathered ? storedHorizon : (horizonDaysByMarket.get(market) ?? 10);
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
    // Two DISTINCT exit conditions share this branch; label them separately with
    // structured reason codes so the trade record isn't mislabeled. A direction
    // flip (held long, fresh signal now points away) is NOT a score comparison —
    // emitting "68 < 37" for a flip is nonsense. Direction flip takes precedence.
    const scoreBelowExit = scoreFresh && sc?.score != null && sc.score < exitThreshold;
    // Only a holding-path short is an exit direction. A candidate-path neutral
    // means "no entry", not "sell an existing position".
    // A held signal becomes `short` below the entry threshold. It is not an
    // independent exit input and must not bypass the lower hysteresis threshold.
    const directionFlipped = scoreFresh && sc?.isHolding === true
      && sc.direction === "short" && sc.score != null && sc.score < exitThreshold;
    if (pos.position_role !== "hedge" && sc?.score != null && !scoreFresh
        && pos.exit_reason !== "score_reassess_exit" && pos.exit_reason !== "llm_exit") {
      staleScoresHeld.push(`${pos.symbol} (${marketSessionsSince(sc.createdAt ?? "", new Date(), market)} sessions old; max ${maxScoreAge})`);
    }

    // Pure score-below-exit (direction still long, NOT a flip) stays immediate —
    // only the direction-flip path is debounced (see below).
    if (pos.position_role !== "hedge" && scoreBelowExit && !directionFlipped) {
      const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
      await closePosition(pos, currentPrice, `score_below_exit_threshold (${sc!.score} < ${exitThreshold})`, outcome);
      continue;
    }

    // Direction-flip: two-step, min-hold-gated. A single flipped session ARMS
    // the exit (staged in exit_reason with the arming session); it only CONFIRMS
    // once a strictly newer research session still flips. A one-session wobble
    // disarms and we hold. This attacks the same-week whipsaw churn (13/22 closed
    // paper trades exited on a flip, min 1.3 days held). See lib/trading/direction-flip.ts.
    if (pos.position_role !== "hedge") {
      const armedSession = parseArmedSession(pos.exit_reason);
      const action = decideDirectionFlip({
        flipped: directionFlipped,
        ageDays,
        minHoldDays: MIN_FLIP_HOLD_DAYS,
        armedSession,
        currentSession: sc?.createdAt != null ? String(sc.createdAt) : null,
      });
      if (action === "confirm") {
        const outcome = classifyOutcome(pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0);
        await closePosition(pos, currentPrice, `direction_flip (confirmed across 2 sessions, now ${sc!.direction})`, outcome);
        continue;
      }
      if (action === "arm") {
        await svc.from("paper_positions")
          .update({ exit_reason: armedFlag(sc?.createdAt != null ? String(sc.createdAt) : null), updated_at: new Date().toISOString() })
          .eq("id", pos.id);
        staleScoresHeld.push(`${pos.symbol} (direction-flip armed: holds until a 2nd flipped session confirms)`);
        continue;
      }
      if (action === "disarm") {
        await svc.from("paper_positions").update({ exit_reason: null, updated_at: new Date().toISOString() }).eq("id", pos.id);
        staleScoresHeld.push(`${pos.symbol} (direction-flip disarmed: signal no longer flipped)`);
        // fall through — position is healthy; let trailing-stop / target below run.
      } else if (action === "too_young") {
        staleScoresHeld.push(`${pos.symbol} (flip ignored: held ${ageDays}d < ${MIN_FLIP_HOLD_DAYS}d min)`);
      }
      // "hold" / "too_young" / post-"disarm": fall through to mechanical stops.
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
    let exitQtyOverride: number | undefined = undefined;
    let partialStopOverride: number | undefined = undefined;

    // Use session low (if available) to detect intraday stop touches.
    // A stop hit mid-session is real even when price recovered by close.
    // Fill price is trailingStop (stop order assumed placed at that level),
    // not the session low — filling at the gap extreme is too pessimistic.
    const posMarket = marketOf(pos, hasMarketColEarly);
    const sessionLow = posMarket === "us" ? (dayLowMap[pos.symbol] ?? currentPrice) : currentPrice;
    const priceForStopCheck = Math.min(currentPrice, sessionLow);
    if (priceForStopCheck <= trailingStop) {
      exitReason = priceForStopCheck < currentPrice ? "stop_hit_intraday" : "stop_hit";
      outcome = trailingStop > pos.avg_cost ? "win" : "loss";
    } else if (pos.position_role !== "hedge" && priceTarget && currentPrice >= priceTarget) {
      // W2-full (2026-08-17): partial profit-taking restored.
      //
      // Migration 20260817180000 adds partial_exit_lot boolean to paper_trades
      // and updates execute_paper_exit to mark residual lots with the flag.
      // The anti-pyramiding trigger and buy-signal unique indexes are updated to
      // exempt flagged rows, so the residual INSERT no longer aborts the run.
      const partialQty = paperPartialTargetQuantity(market, pos.qty);
      if (partialQty !== null && partialQty < Number(pos.qty)) {
        // Partial: close half at target, let the runner run with stop→breakeven.
        exitReason = "partial_target";
        outcome = "win";
        exitQtyOverride = partialQty;
        partialStopOverride = Number(pos.avg_cost); // breakeven stop on remainder
      } else {
        // Position too small to split or helper returned null → full exit.
        exitReason = "target_hit";
        outcome = "win";
      }
    }

    if (exitReason && outcome) {
      // Stop exits: fill at trailingStop (the stop order level), not currentPrice.
      // An intraday or gap stop may have triggered at a price above current close.
      const fillPrice = exitReason === "stop_hit" || exitReason === "stop_hit_intraday"
        ? trailingStop : currentPrice;
      await closePosition(pos, fillPrice, exitReason, outcome, exitQtyOverride, partialStopOverride);
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
   } catch (err: unknown) {
    // Isolated: this position is not evaluated, every other one still is.
    const reason = err instanceof Error ? err.message : String(err);
    exitFailures.push({
      symbol: String(pos.symbol),
      market: marketOf(pos, hasMarketCol),
      reason,
    });
   }
  }

  if (exitFailures.length > 0) {
    await reportIssue({
      issueKey: `position-monitor-exit-failed:${marketScope ?? "all"}`,
      severity: "critical", category: "risk",
      title: `PositionMonitor could not evaluate ${exitFailures.length} position(s)`,
      detail:
        `These positions were SKIPPED and their stops/targets were NOT checked this run: ` +
        exitFailures.map((f) => `${f.symbol} (${f.market}) — ${f.reason}`).join("; ") +
        `. Every other position was evaluated normally. A lot/position parity ` +
        `mismatch means the ledger disagrees with the position row and must be ` +
        `reconciled through the transactional exit path — never by deleting rows.`,
    }, svc);
  } else {
    await resolveIssue(`position-monitor-exit-failed:${marketScope ?? "all"}`, svc);
  }

  // Recompute + persist NAV PER MARKET = that pool's cash + mark-to-market of its
  // still-open positions. Each currency stays in its own pool; never summed.
  // Scoped like the read at the top of the run. This re-read was UNFILTERED,
  // so a `?market=india` run still loaded all 27 positions and, with the
  // equally-unfiltered pool map below, marked and wrote EOD rows for BOTH
  // markets — see the loop guard on `poolByMarket`.
  let stillOpenQuery = svc.from("paper_positions")
    .select("id, symbol, qty, avg_cost, current_price, updated_at, market");
  if (marketScope && hasMarketCol) stillOpenQuery = stillOpenQuery.eq("market", marketScope);
  const { data: stillOpen } = await stillOpenQuery;
  const today = new Date().toISOString().slice(0, 10);
  // Synthetic run key for the mark ledger. agent_runs' own id isn't minted until
  // the end of this function, and the ledger row must name the run that wrote it.
  const markRunId = `position_monitor:${startedAt}`;
  // Track NAV/performance write failures (P0-4): a rejected update must fail the
  // run visibly, not be swallowed.
  const navWriteErrors: string[] = [];
  let navInvariantOk = true;
  const navInvariantDrift: Record<string, number> = {};
  // W4 reporting: per-market mark provenance and the post-write reconciliation.
  const markCoverageByMarket: Record<string, any> = {};
  const navChecksByMarket: Record<string, any> = {};
  let markLedgerStatus: "written" | "unavailable" | "not_attempted" = "not_attempted";
  let markLedgerDetail: string | null = null;
  for (const [market, pool] of poolByMarket) {
    // 2026-08-18: `poolByMarket` holds EVERY portfolio row and was never scoped,
    // so the India cron (11:15 UTC) wrote a US mark set and a US
    // `paper_performance` row stamped `snapshot_type='eod'` at 07:15 ET — before
    // the US session had even opened. That breaks the W4 invariant of ONE
    // canonical EOD writer per market, arriving from the other market's
    // schedule. A market-scoped run touches only its own market.
    if (marketScope && market !== marketScope) continue;
    const mktPos = (stillOpen ?? []).filter((p: any) => marketOf(p, hasMarketCol) === market);

    // W4 — every open qty gets exactly ONE mark, and that mark says where it
    // came from. `priceMap` holds only quotes that passed the adapter freshness
    // rule THIS run; anything absent falls back to the persisted mark (stale,
    // dated) or to entry cost (never priced), each recorded explicitly instead
    // of silently blending into the same NAV number.
    const marks: PositionMark[] = mktPos.map((p: any) => buildPositionMark({
      positionId: String(p.id),
      symbol: String(p.symbol),
      market: market as "us" | "india",
      qty: Number(p.qty ?? 0),
      avgCost: Number(p.avg_cost ?? 0),
      persistedPrice: p.current_price == null ? null : Number(p.current_price),
      persistedAt: p.updated_at ?? null,
      livePrice: priceMap[String(p.symbol)] ?? null,
      liveSource: quoteMeta[String(p.symbol)]?.source ?? null,
      liveObservedAt: quoteMeta[String(p.symbol)]?.observedAt ?? null,
    }));
    const newNav = navFromMarks(cashByMarket[market], marks);
    const positionsValue = newNav - cashByMarket[market];
    const coverage = summariseMarkCoverage(marks);
    markCoverageByMarket[market] = coverage;

    // Append-only mark ledger. Best-effort by design: the table arrives with an
    // unapplied migration, so a missing relation must not take down the money
    // path — but the status is reported, never assumed.
    if (marks.length) {
      const { error: ledgerErr } = await svc.from("paper_position_marks")
        .insert(marks.filter(m => m.qty > 0 && m.mark > 0)
          .map(m => markLedgerRow(m, { runId: markRunId, sessionDate: today })));
      if (!ledgerErr) markLedgerStatus = "written";
      else if (isMissingSchema(ledgerErr)) {
        markLedgerStatus = "unavailable";
        markLedgerDetail = "paper_position_marks migration not applied yet";
      } else {
        markLedgerStatus = "unavailable";
        markLedgerDetail = ledgerErr.message;
      }
    }

    // Mixed-age marks are a reportable condition, not a silent one. NAV built
    // partly from yesterday's prices is still written (refusing to write NAV
    // would be worse), but the share carried on stale marks is surfaced.
    const staleIssueKey = `paper-nav-stale-marks:${market}`;
    if (coverage.liveQty < coverage.totalQty) {
      const staleSyms = marks.filter(m => m.stale).map(m => `${m.symbol} (${m.provenance})`);
      await reportIssue({
        issueKey: staleIssueKey,
        severity: "warn", category: "paper-truth",
        title: `Paper NAV blends stale marks — ${market.toUpperCase()} (${(coverage.staleValuePct ?? 0).toFixed(1)}% of position value)`,
        detail: `No fresh quote this run for: ${staleSyms.join(", ")}. Their NAV weight is carried at a previous mark or at entry cost, so today's NAV mixes prices of different ages. See paper_position_marks for the per-position provenance.`,
        autoExpireAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }, svc);
    } else {
      await resolveIssue(staleIssueKey, svc);
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
    let ledgerCash: number | null = null;
    try {
      const seed = market === "india" ? 1_000_000 : 10_000;
      const openCost = mktPos.reduce(
        (s: number, p: any) => s + Number(p.qty ?? 0) * Number(p.avg_cost ?? 0), 0);
      const { data: realizedRows } = await svc.from("paper_trades")
        .select("realized_pnl").eq("market", market).not("closed_at", "is", null);
      const realized = (realizedRows ?? []).reduce(
        (s: number, r: any) => s + Number(r.realized_pnl ?? 0), 0);
      const ledger = seed - openCost + realized;
      ledgerCash = ledger;
      const drift = Math.abs(cashByMarket[market] - ledger);
      const tol = Math.max(1, seed * 0.005); // 0.5% of seed
      if (drift > tol) {
        await reportIssue({
          issueKey: `paper-cash-drift:${market}`,
          severity: "warn", category: "risk",
          title: `Paper cash ledger drift — ${market.toUpperCase()} (${drift.toFixed(0)})`,
          detail: `cash_balance ${cashByMarket[market].toFixed(0)} != ledger ${ledger.toFixed(0)} (seed − open-cost + realized). A close-proceeds write was likely lost — reconcile before trusting NAV/drawdown; the drawdown breaker may be acting on a phantom NAV.`,
        }, svc);
      } else {
        await resolveIssue(`paper-cash-drift:${market}`, svc);
      }
    } catch { /* guard is advisory — never block the monitor */ }

    // W5 — benchmark daily sync from SESSION-DATED daily bars, not a quote.
    // The old code took VOO's quote and stored whatever positive number came
    // back under the cron's run date: VOO's 2026-08-11 close (708.42) is
    // persisted under both 2026-08-12 and 2026-08-13. A benchmark level may
    // only be written against a NAV row representing the SAME market close, so
    // the bar's own date must equal this row's date or we write no benchmark.
    let benchNav: number | null = null;
    let benchReturnPct: number | null = null;
    let benchSessionDate: string | null = null;
    let benchSource: string | null = null;
    let benchSkipReason: string | null = null;
    const [previousPerfResult, resolvedTradesResult] = await Promise.all([
      svc.from("paper_performance").select("nav").eq("market", market)
        .lt("date", today).order("date", { ascending: false }).limit(1).maybeSingle(),
      svc.from("paper_trades").select("outcome").eq("market", market)
        .not("outcome", "is", null),
    ]);
    if (previousPerfResult.error) throw new Error(`Previous NAV read failed (${market}): ${previousPerfResult.error.message}`);
    if (resolvedTradesResult.error) throw new Error(`Paper outcomes read failed (${market}): ${resolvedTradesResult.error.message}`);
    const previousPerf = previousPerfResult.data;
    const resolvedTrades = resolvedTradesResult.data;
    const outcomes = (resolvedTrades ?? []) as Array<{ outcome: string | null }>;
    const benchResult = await fetchBenchmarkObservation(market as "us" | "india", today);
    if (benchResult.ok) {
      benchNav = benchResult.observation.close;
      benchSessionDate = benchResult.observation.sessionDate;
      benchSource = benchResult.observation.source;
      const { data: firstPerf } = await svc.from("paper_performance")
        .select("bench_nav").eq("market", market).not("bench_nav", "is", null)
        .order("date", { ascending: true }).limit(1).maybeSingle();
      benchReturnPct = benchmarkReturnPct(benchNav, (firstPerf as any)?.bench_nav ?? benchNav);
    } else {
      // A gap is honest; a benchmark stamped with the wrong session is not.
      benchSkipReason = `${benchResult.reason}: ${benchResult.detail}`;
      console.warn(`[position-monitor] no benchmark observation for ${market} ${today} — ${benchSkipReason}`);
    }

    const truth = paperPerformanceTruth({
      market: market as "us" | "india",
      nav: newNav,
      previousNav: previousPerf?.nav == null ? null : Number(previousPerf.nav),
      benchReturnPct,
      winCount: outcomes.filter((t) => t.outcome === "win").length,
      lossCount: outcomes.filter((t) => t.outcome === "loss").length,
      resolvedTradeCount: resolvedPaperOutcomeCount(outcomes),
    });

    const perfRow: Record<string, any> = {
      date: today, market, nav: newNav,
      cash_balance: cashByMarket[market], positions_value: positionsValue,
      ...truth,
      bench_nav: benchNav, bench_return_pct: benchReturnPct,
      spy_nav: market === "us" ? benchNav : null,
      spy_return_pct: market === "us" ? benchReturnPct : null,
      updated_at: new Date().toISOString(),
      // W4/W5 provenance. Dropped automatically when the migration hasn't been
      // applied yet (see the retry below), so this file is safe to ship first.
      bench_session_date: benchSessionDate,
      bench_source: benchSource,
      // PositionMonitor is the ONE canonical EOD writer per market — but only
      // once THAT market's session has actually closed. An unscoped or manual
      // run firing before the close would otherwise stamp `eod` on a row built
      // from carry-forward marks, which is the same lie in a different costume.
      // `expectedNewestSession` returns today only after today's close.
      snapshot_type: expectedNewestSession(market as "us" | "india") === today ? "eod" : "intraday",
    };
    // PostgREST returns { error } rather than throwing, so the old `.catch` never
    // fired on a real write failure. Retry ladder: drop the not-yet-migrated
    // provenance columns, then the pre-057 "no market column" case keyed on date
    // only; any surviving error fails the run visibly.
    const upsertPerf = async (row: Record<string, any>) => {
      const first = await svc.from("paper_performance").upsert(row, { onConflict: "date,market" });
      if (!first.error) return first;
      return svc.from("paper_performance").upsert({ ...row, market: undefined }, { onConflict: "date" });
    };
    let perfWrite = await upsertPerf(perfRow);
    if (perfWrite.error && isMissingSchema(perfWrite.error)) {
      const { bench_session_date, bench_source, snapshot_type, ...legacyRow } = perfRow;
      perfWrite = await upsertPerf(legacyRow);
    }
    if (perfWrite.error) navWriteErrors.push(`paper_performance(${market}): ${perfWrite.error.message}`);

    // ── W4: the NAV invariant that can actually fail ─────────────────────────
    // What was here before compared `newNav` with `invariantExpected`, both the
    // same reduce over the same array: `invariantDiff` was structurally zero and
    // the violation branch was unreachable. It was one of the five checks in the
    // 2026-08-16 incident that could only ever report green.
    //
    // This reads the numbers BACK OUT OF THE DATABASE after the write and
    // compares them against a NAV computed here from cash plus the mark set.
    // Both sides are independently sourced, so a dropped write, a rejected
    // column, a partial upsert or a mark missing from NAV now produces a failing
    // check instead of a tautology.
    const [poolAfter, perfAfter] = await Promise.all([
      svc.from("paper_portfolio").select("nav, cash_balance").eq("id", pool.id).maybeSingle(),
      svc.from("paper_performance").select("nav").eq("market", market).eq("date", today).maybeSingle(),
    ]);
    const reconciliation = reconcilePersistedNav({
      market: market as "us" | "india",
      cash: cashByMarket[market],
      marks,
      persistedPortfolioNav: (poolAfter.data as any)?.nav,
      persistedPortfolioCash: (poolAfter.data as any)?.cash_balance,
      persistedPerformanceNav: (perfAfter.data as any)?.nav,
      ledgerCash,
    });
    navChecksByMarket[market] = {
      ok: reconciliation.ok,
      checks: reconciliation.checks,
      bench_session_date: benchSessionDate,
      bench_source: benchSource,
      bench_skipped: benchSkipReason,
    };
    if (!reconciliation.ok) {
      navInvariantOk = false;
      navInvariantDrift[market] = Math.max(0, ...reconciliation.checks.map(c => c.diff ?? 0));
      console.warn(`[position-monitor] NAV reconciliation FAILED (${market}): ${reconciliation.violations.join(" | ")}`);
      await reportIssue({
        issueKey: `paper-nav-reconcile:${market}`,
        severity: "critical", category: "paper-truth",
        title: `Paper NAV does not reconcile after write — ${market.toUpperCase()}`,
        detail: `The persisted book disagrees with cash + marks: ${reconciliation.violations.join(" | ")}`.slice(0, 500),
      }, svc);
    } else {
      await resolveIssue(`paper-nav-reconcile:${market}`, svc);
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
          // Per-market pause (migration 171): pause ONLY this market's new
          // entries, not the other's. (This breaker paused US research via the
          // old global app_paused on 2026-07-13.)
          await setMarketPaused(svc, market, true, `NAV drawdown ${(weeklyReturn * 100).toFixed(1)}%/7d`);
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
  // W4: a NAV that does not reconcile after write is as serious as a rejected
  // write, and must fail the run the same way. The old invariant could not
  // reach this branch because it compared an expression with itself.
  const navBookFailed = navWriteFailed || !navInvariantOk;
  const navAlertKey = `position-monitor-nav-write:${marketScope ?? "us"}`;
  const reconcileFailures = Object.entries(navChecksByMarket)
    .filter(([, v]) => !(v as any).ok)
    .map(([m]) => m);
  try {
    await svc.from("agent_runs").insert({
      agent_type: "position_monitor",
      market: marketScope ?? "us",
      status: navBookFailed ? "error" : "done",
      symbols: positions.map((p: any) => String(p.symbol)),
      trigger_source: marketScope ? "scheduled" : "manual",
      result_summary: navBookFailed
        ? (navWriteFailed
            ? `NAV/performance write FAILED: ${navWriteErrors.join("; ")}`
            : `NAV did not reconcile after write for: ${reconcileFailures.join(", ")}`).slice(0, 500)
        : `Checked ${positions.length}, closed ${closed.length}, updated ${updated.length}, unpriced ${unpricedByMarket.us.length + unpricedByMarket.india.length}, stale scores held ${staleScoresHeld.length}. Mark ledger ${markLedgerStatus}${markLedgerDetail ? ` (${markLedgerDetail})` : ""}.`,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      workload_metrics: runAccountingEnvelope({
        job: `position-monitor:${marketScope ?? "us"}`,
        market: (marketScope ?? "us") as "us" | "india",
        eligible: positions.length,
        succeeded: closed.length + updated.length,
        expectedSkip: 0,
        deferred: 0,
        unavailable: unpricedByMarket.us.length + unpricedByMarket.india.length,
        // Positions whose evaluation threw (e.g. a denied exit). Isolated above
        // so the run continues, but they ARE failed units: the W6 contract fires
        // a critical on any failed unit regardless of how many succeeded, which
        // is right — a position whose stop went unchecked is not a healthy run.
        failed: exitFailures.length,
        businessMetrics: {
          closed: closed.length,
          stops_updated: updated.length,
          stale_held: staleScoresHeld.length,
          exit_failures: exitFailures.length,
        },
      }),
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
    stale_scores_held: staleScoresHeld,
    unpriced: unpricedByMarket,
    nav_write_ok: !navWriteFailed,
    nav_write_errors: navWriteErrors,
    nav_invariant_ok: navInvariantOk,
    nav_invariant_drift: navInvariantDrift,
    // W4: how much of NAV is carried on stale marks, per market, and the
    // post-write reconciliation each market actually passed or failed.
    mark_coverage: markCoverageByMarket,
    nav_reconciliation: navChecksByMarket,
    mark_ledger: { status: markLedgerStatus, detail: markLedgerDetail },
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
    const localSlot = new URL(req.url).searchParams.get("local_slot");
    if (isCron && localSlot) {
      if (!scope) return NextResponse.json({ error: "local_slot requires market=us|india" }, { status: 400 });
      const slot = admitMarketLocalSlot(scope, localSlot);
      if (!slot.admitted) {
        return NextResponse.json({ skipped: true, reason: slot.reason, expected: localSlot, local_time: slot.localTime });
      }
    }
    const startedAt = new Date().toISOString();
    try {
      const result = await runMonitor(scope, startedAt);
      return NextResponse.json({ success: true, ...result });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await logMonitorError(scope, msg, startedAt);
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
  const localSlot = new URL(req.url).searchParams.get("local_slot");
  if (isCron && localSlot) {
    if (!scope) return NextResponse.json({ error: "local_slot requires market=us|india" }, { status: 400 });
    const slot = admitMarketLocalSlot(scope, localSlot);
    if (!slot.admitted) {
      return NextResponse.json({ skipped: true, reason: slot.reason, expected: localSlot, local_time: slot.localTime });
    }
  }
  const startedAt = new Date().toISOString();
  try {
    const result = await runMonitor(scope, startedAt);
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    await logMonitorError(scope, msg, startedAt);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
