import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

// PositionMonitor: daily after-market check for stop-loss hits and price-target hits.
// Uses trailing-stop logic: stop rises with highest_price but never falls below original stop.
// Also honors exit_reason="llm_exit" flags set by LearnerAgent — closes those on next run.
export const dynamic = "force-dynamic";

async function runMonitor() {
  const svc = createServiceClient();

  // 1. Fetch all paper positions — paper_positions has NO closed_at column
  // (confirmed via information_schema): a position is "open" simply by the
  // row existing; closing means deleting it or reducing qty (see learner
  // route's cutoff-closing logic for the same pattern). The old
  // `.is("closed_at", null)` filter queried a nonexistent column, Supabase
  // returned an error that was never checked, and this route silently did
  // nothing on every single run since — including never refreshing
  // current_price, which is why stale prices lingered for days.
  const { data: positions } = await svc
    .from("paper_positions")
    .select("*");

  if (!positions?.length) return { checked: 0, closed: 0, closedDetails: [], updated: 0 };

  // 2. Batch fetch current prices via Massive
  const symbols: string[] = Array.from(new Set(positions.map((p: any) => String(p.symbol))));
  const massiveKey = process.env.MASSIVE_API_KEY;

  const priceMap: Record<string, number> = {};
  if (massiveKey) {
    await Promise.allSettled(
      symbols.map(async (sym) => {
        try {
          const res = await fetch(
            `https://api.massive.com/v2/aggs/ticker/${sym}/prev?adjusted=true&apiKey=${massiveKey}`
          );
          const d = await res.json();
          if (d.results?.[0]?.c) priceMap[sym] = d.results[0].c;
        } catch {
          // silently skip unavailable symbols
        }
      })
    );
  }

  // 3. Fetch portfolio for cash updates
  const { data: portfolio } = await svc.from("paper_portfolio").select("*").single();
  let cashBalance = portfolio?.cash_balance ?? 10000;

  // 3b. Daily score-based exit. ResearchAgent re-scores held symbols every
  // trading morning (Mon-Fri); PositionMonitor runs every trading afternoon.
  // So the RIGHT place for "hold while the AI score stays above threshold,
  // exit when it drops below" is HERE, daily — not in LearnerAgent Phase A,
  // which runs weekly (Friday) at best and would leave a decayed position
  // open for days. Fetch the latest analyst_score + direction per held symbol
  // and exit any whose conviction has fallen below the exit threshold.
  // Exit threshold sits below the entry threshold (hysteresis) so a position
  // isn't churned out the moment it dips one point under the buy bar.
  const { data: strategyCfg } = await svc.from("strategy_config").select("score_threshold, min_analyst_score").maybeSingle();
  const entryThreshold = Number((strategyCfg as any)?.score_threshold ?? (strategyCfg as any)?.min_analyst_score ?? 60);
  const exitThreshold = Math.max(35, entryThreshold - 15); // e.g. enter 60, exit below 45
  const latestScore: Record<string, { score: number | null; direction: string | null }> = {};
  for (const sym of symbols) {
    const { data: sig } = await svc.from("agent_signals")
      .select("analyst_score, direction")
      .eq("symbol", sym)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();
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
    const realizedPnl = (currentPrice - pos.avg_cost) * pos.qty;
    const pnlPct = pos.avg_cost > 0 ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : 0;

    const { data: openTrades } = await svc
      .from("paper_trades")
      .select("id")
      .eq("symbol", pos.symbol)
      .is("closed_at", null);
    for (const t of openTrades ?? []) {
      await svc.from("paper_trades").update({
        exit_price: currentPrice, realized_pnl: realizedPnl, pnl_pct: pnlPct,
        outcome, closed_at: new Date().toISOString(),
      }).eq("id", (t as any).id);
    }

    await svc.from("paper_positions").delete().eq("id", pos.id);

    // Decision Journal was showing "0 entries" because nothing ever wrote to
    // it for exits — only the initial buy fill (paper-trade/route.ts) did.
    // Log the exit so the journal actually reflects the position lifecycle.
    const { error: journalError } = await svc.from("decision_journal").insert({
      entry_type: "paper_exit",
      symbol: pos.symbol,
      summary: `Paper exit: ${pos.qty} × ${pos.symbol} @ $${currentPrice.toFixed(2)} (${exitReason}), P&L $${realizedPnl.toFixed(2)} (${outcome})`,
      calculations: { qty: pos.qty, exit_price: currentPrice, avg_cost: pos.avg_cost, realized_pnl: realizedPnl, pnl_pct: pnlPct, exit_reason: exitReason },
      has_verified_facts: true,
      has_calculations: true,
      resolved: true,
      resolved_at: new Date().toISOString(),
    });
    if (journalError) console.error("[position-monitor] decision_journal insert failed:", journalError.message);

    cashBalance += currentPrice * pos.qty;
    closed.push(`${pos.symbol} (${exitReason}: $${currentPrice.toFixed(2)}, P&L: $${realizedPnl.toFixed(2)})`);
  }

  for (const pos of positions) {
    const currentPrice = priceMap[pos.symbol];

    // Handle llm_exit flag set by LearnerAgent — close position if flagged and we have a price
    if (pos.exit_reason === "llm_exit" && currentPrice) {
      const outcome = (currentPrice - pos.avg_cost) * pos.qty > 0.5 ? "win"
        : (currentPrice - pos.avg_cost) * pos.qty < -0.5 ? "loss" : "breakeven";
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
      const outcome = (currentPrice - pos.avg_cost) * pos.qty > 0.5 ? "win"
        : (currentPrice - pos.avg_cost) * pos.qty < -0.5 ? "loss" : "breakeven";
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

  // Recompute + persist NAV = cash + mark-to-market of every still-open
  // position (using the freshly refreshed current_price, or avg_cost for
  // anything Massive had no price for). paper_portfolio.nav was only ever
  // set at seed time and on close — it never reflected open-position
  // mark-to-market, so NAV showed a flat $10,000 even with real unrealized
  // gains sitting in paper_positions (e.g. +$31.81 on an open META position).
  const { data: stillOpen } = await svc.from("paper_positions").select("qty, avg_cost, current_price");
  const positionsValue = (stillOpen ?? []).reduce((sum: number, p: any) => {
    const price = Number(p.current_price ?? p.avg_cost ?? 0);
    return sum + Number(p.qty ?? 0) * price;
  }, 0);
  const newNav = cashBalance + positionsValue;

  const { count: allOpenCount } = await svc
    .from("paper_positions")
    .select("id", { count: "exact", head: true });

  await svc.from("paper_portfolio").update({
    cash_balance: cashBalance,
    nav: newNav,
    open_positions: allOpenCount ?? Math.max(0, positions.length - closed.length),
    updated_at: new Date().toISOString(),
  }).eq("id", portfolio?.id);

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

    const result = await runMonitor();
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
    const result = await runMonitor();
    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
