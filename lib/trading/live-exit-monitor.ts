// Live protective-exit monitor (R16). A filled live BUY has automated ENTRY,
// reconcile, and cancel-on-kill — but nothing auto-SELLS it at a stop/target/time
// (the paper PositionMonitor manages paper positions only). This closes that gap
// for BOTH markets: it reconstructs open LIVE positions from filled broker_orders,
// and when a protective trigger fires it SELLs through the same hardened gateway
// (executeApprovedOrder, autonomous_worker). SELLs reduce exposure, are held-only
// (verified against the live broker) + idempotent + journaled, and are exempt
// from the daily BUY caps.
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";
import { getQuote } from "@/lib/data/quotes";
import { fetchIndiaQuote } from "@/lib/india-data";
import { executeApprovedOrder } from "@/lib/trading/execute-order";
import { isMarketOpenLive } from "@/lib/trading/market-calendar";
import { loadTradingMandateStrict, tradingWeekdaysBetween } from "@/lib/trading-mandate";
import { reconstructAccountLivePositions } from "@/lib/trading/live-position-ledger";
import { cancelProtectiveStop } from "@/lib/protective/placement-worker";
import { managedLivePositionId } from "@/lib/protective/coverage";
import { decideExitLadder } from "@/lib/trading/exit-ladder";

/** Supabase numerics arrive as string|number|null; a bad value must not become 0. */
function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const MARKET_CFG: Record<string, { brokers: string[]; accountCol: string }> = {
  us:    { brokers: ["robinhood", "robinhood_mcp"], accountCol: "active_account_us" },
  india: { brokers: ["kite"],                        accountCol: "active_account_india" },
};

export interface LiveExitResult {
  run_id: string;
  early_exit?: string;
  positions_checked: number;
  exits_submitted: number;
  results: Array<{ market: string; symbol: string; qty: number; reason: string; status: string; error?: string }>;
}

async function priceFor(market: string, symbol: string, svc: SupabaseClient): Promise<{ price: number; ok: boolean }> {
  try {
    if (market === "india") { const q = await fetchIndiaQuote(symbol); const p = q?.price ?? 0; return { price: p, ok: p > 0 }; }
    const q = await getQuote(symbol, svc); const p = q.price ?? 0; return { price: p, ok: p > 0 && !q.stale };
  } catch { return { price: 0, ok: false }; }
}

export async function runLiveExitMonitor(svc: SupabaseClient, runId: string): Promise<LiveExitResult> {
  const base = { run_id: runId, positions_checked: 0, exits_submitted: 0, results: [] as LiveExitResult["results"] };
  const early = (early_exit: string): LiveExitResult => ({ ...base, early_exit });

  if (!AUTONOMOUS_LIVE_ENABLED) return early("deployment_flag_inactive");
  const { data: cfg, error: cfgError } = await svc.from("strategy_config")
    .select("live_auto_enabled, app_paused, security_locked, active_account_us, active_account_india").limit(1).maybeSingle();
  if (cfgError) throw new Error(`live-exit config read failed: ${cfgError.message}`);
  if (!cfg) return early("no_config");
  if ((cfg as any).app_paused || (cfg as any).security_locked) return early("paused_or_locked");

  // SHADOW MODE (features/live-exit-ladder-parity, owner-approved 2026-09-09).
  //
  // This used to `return early("db_toggle_off")` here, which made the exit
  // engine completely unobservable until live_auto_enabled was flipped — the
  // wrong way round, since the whole point of building ladder parity is to
  // have it proven BEFORE enabling anything. With the toggle off we now run
  // the full evaluation and write what we WOULD have done to
  // live_exit_ladder_shadow, submitting nothing. app_paused and
  // security_locked remain hard stops above: those mean "do not run", not
  // "run without acting".
  const shadowMode = !(cfg as any).live_auto_enabled;

  const results: LiveExitResult["results"] = [];
  let exitsSubmitted = 0;
  let checked = 0;

  for (const market of ["us", "india"] as const) {
    const mc = MARKET_CFG[market];
    const account = (cfg as any)[mc.accountCol] as string | null;
    if (!account) continue;                               // market not set up
    const live = await isMarketOpenLive(market);
    if (!live.open) continue;                             // out of session for this market
    const mandate = await loadTradingMandateStrict(svc, market);

    const { data: fills, error: fillsError } = await svc.from("broker_orders")
      .select("proposal_id, symbol, side, filled_qty, qty, avg_fill_price, created_at, status")
      .eq("broker_env", "live").eq("market", market).eq("status", "filled")
      .in("broker", mc.brokers);
    if (fillsError) throw new Error(`live-exit ${market} fill read failed: ${fillsError.message}`);
    const proposalIds = [...new Set((fills ?? []).map((row: any) => row.proposal_id).filter((id: any) => id != null))];
    let proposals: any[] = [];
    if (proposalIds.length) {
      const { data, error } = await svc.from("trade_proposals")
        .select("id,account_number,policy_snapshot").in("id", proposalIds);
      if (error) throw new Error(`live-exit ${market} lineage read failed: ${error.message}`);
      proposals = data ?? [];
    }
    const positions = reconstructAccountLivePositions({
      orders: (fills ?? []) as any[],
      proposals,
      activeAccount: account,
      fallbackPolicy: {
        stopLossPct: mandate.stop_loss_pct,
        targetPct: mandate.target_pct,
        maxHoldDays: mandate.max_hold_days,
        horizonDays: mandate.target_hold_days,
        mandateVersion: mandate.version,
      },
    });

    // Ladder state for this account, loaded once per market rather than per
    // position (the loop below can run for every open name).
    const ladderState = new Map<string, any>();
    if (positions.length) {
      const { data: stateRows, error: stateErr } = await svc.from("live_position_state")
        .select("symbol, highest_price, trailing_stop, partial_taken_at, partial_qty, opened_at")
        .eq("account_id", account).eq("market", market);
      if (stateErr) throw new Error(`live-exit ${market} ladder state read failed: ${stateErr.message}`);
      for (const row of (stateRows ?? []) as any[]) ladderState.set(String(row.symbol), row);
    }

    for (const p of positions) {
      const symbol = p.symbol;
      if (p.qty < 1) continue;
      checked++;

      const pr = await priceFor(market, symbol, svc);
      if (!pr.ok) continue;
      const price = pr.price;

      // Shared ladder core — the SAME function the paper monitor calls, so
      // partial-target and trailing behavior cannot diverge between the two.
      // Live-only state (high-water mark, trailing stop, whether the partial
      // already fired) comes from live_position_state, because live positions
      // are reconstructed statelessly from fills and remember nothing.
      const stateRow = ladderState.get(`${symbol}`);
      const positionOpenedAt = new Date(p.firstBuyAt).toISOString();
      // Re-entry guard: a state row older than this position's first buy
      // belongs to a CLOSED position. Inheriting it would start a fresh
      // position believing profit was already taken.
      const stateIsCurrent = stateRow != null && stateRow.opened_at != null
        && Date.parse(stateRow.opened_at) >= Date.parse(positionOpenedAt) - 1000;

      const ageDays = tradingWeekdaysBetween(new Date(p.firstBuyAt), new Date());
      const decision = decideExitLadder({
        market,
        qty: p.qty,
        avgEntry: p.avgEntry,
        price,
        priceTarget: p.targetPrice,
        initialStopLoss: p.stopPrice,
        currentStop: stateIsCurrent ? numberOrNull(stateRow!.trailing_stop) : p.stopPrice,
        highestPrice: stateIsCurrent ? numberOrNull(stateRow!.highest_price) : p.avgEntry,
        ageDays,
        horizonDays: p.horizonDays,
        partialTaken: stateIsCurrent && stateRow!.partial_taken_at != null,
      });

      // Persist the ratchet every run, exit or not — this is what gives live
      // positions the memory paper gets from its mutable row.
      await svc.from("live_position_state").upsert({
        account_id: account, symbol, market,
        highest_price: decision.highestPrice,
        trailing_stop: decision.action === "partial_target" ? decision.runnerStop : decision.trailingStop,
        opened_at: positionOpenedAt,
        updated_at: new Date().toISOString(),
        ...(stateIsCurrent ? {} : { partial_taken_at: null, partial_qty: null }),
      }, { onConflict: "account_id,symbol" });

      if (shadowMode) {
        // Log the intent, submit nothing. This is the whole point of shadow
        // mode: parity is observable on real positions before the live toggle.
        await svc.from("live_exit_ladder_shadow").insert({
          account_id: account, market, symbol,
          action: decision.action, reason: decision.reason,
          price, qty_held: p.qty, qty_would_exit: decision.exitQty ?? null,
          trailing_stop: decision.trailingStop, runner_stop: decision.runnerStop ?? null,
          highest_price: decision.highestPrice,
          shadow_mode: true,
        });
        if (decision.action !== "none") {
          results.push({ market, symbol, qty: decision.exitQty ?? 0, reason: decision.reason ?? decision.action, status: "shadow_logged" });
        }
        continue;
      }

      if (decision.action === "none" || decision.action === "runner_hold") continue;
      const reason = decision.reason ?? decision.action;

      // India trades whole shares; US allows fractional. Never round a partial
      // UP — that would sell more of the runner than the ladder decided.
      const rawExitQty = decision.exitQty ?? p.qty;
      const qty = market === "india" ? Math.floor(rawExitQty) : rawExitQty;
      if (!(qty > 0)) continue;

      // Idempotency: skip if a pending or queued autonomous SELL already exists
      // for this symbol, or if a live SELL order is already resting at the broker.
      // Without this, two concurrent exit-monitor runs submit duplicate SELLs.
      const { data: pendingSell, error: pendingSellError } = await svc.from("trade_proposals")
        .select("id").eq("symbol", symbol).eq("market", market).eq("side", "sell")
        .eq("account_number", account)
        .eq("execution_mode", "autonomous_live")
        .in("status", ["pending_review", "queued_auto"])
        .limit(1).maybeSingle();
      if (pendingSellError) {
        results.push({ market, symbol, qty, reason, status: "blocked", error: `sell-proposal check failed: ${pendingSellError.message}` });
        continue;
      }
      if (pendingSell) {
        results.push({ market, symbol, qty, reason, status: "skipped_duplicate", error: `existing sell proposal ${(pendingSell as any).id}` });
        continue;
      }
      const { data: activeSellOrder, error: activeSellError } = await svc.from("broker_orders")
        .select("id").eq("market", market).eq("broker_env", "live")
        .eq("symbol", symbol).eq("side", "sell")
        .in("status", ["pending_submit", "submitted", "partially_filled"])
        .limit(1).maybeSingle();
      if (activeSellError) {
        results.push({ market, symbol, qty, reason, status: "blocked", error: `active-order check failed: ${activeSellError.message}` });
        continue;
      }
      if (activeSellOrder) {
        results.push({ market, symbol, qty, reason, status: "skipped_duplicate", error: `active sell order ${(activeSellOrder as any).id}` });
        continue;
      }

      // Cancel any resting broker-side protective stop BEFORE submitting the SELL.
      // Without this, the GTC stop (RH) or GTT (Kite) can trigger AFTER the exit
      // SELL settles — selling a position we no longer own (naked short risk).
      // Best-effort: a cancel failure is logged but does NOT abort the SELL (the
      // protective-orders row is moved to needs_reconcile for manual follow-up).
      const positionId = managedLivePositionId({
        market,
        broker: MARKET_CFG[market].brokers[0],
        brokerAccountId: account,
        symbol,
        qty,
      });
      await cancelProtectiveStop({ supabase: svc, positionId, market, brokerAccountId: account }).catch(() => {});

      const { data: prop, error: propErr } = await svc.from("trade_proposals").insert({
        symbol, market, side: "sell", order_type: "market", qty,
        status: "pending_review", execution_mode: "autonomous_live",
        auto_run_id: runId, auto_decided_at: new Date().toISOString(),
        account_number: account,
        price_at_proposal: price, price_source: "live_exit_monitor",
        thesis: `Protective exit — ${reason}`,
        policy_snapshot: {
          version: "v1", source: "live_exit_monitor", account_number: account,
          position_policy_source: p.policySource, avg_entry: p.avgEntry,
          stop_price: p.stopPrice, target_price: p.targetPrice,
          first_buy_at: p.firstBuyAt, horizon_days: p.horizonDays, trigger_reason: reason,
        },
      }).select("id").single();
      if (propErr) {
        // 23505 = unique_violation from trade_proposals_active_sell_uniq partial index.
        // A concurrent monitor run already inserted an active SELL — treat as duplicate.
        if (propErr.code === "23505") {
          results.push({ market, symbol, qty, reason, status: "skipped_duplicate", error: "concurrent insert conflict resolved by DB constraint" });
          continue;
        }
        results.push({ market, symbol, qty, reason, status: "proposal_failed", error: propErr.message });
        continue;
      }
      if (!prop) {
        results.push({ market, symbol, qty, reason, status: "proposal_failed", error: "insert returned no row" });
        continue;
      }
      const exec = await executeApprovedOrder(svc, { proposalId: (prop as any).id, env: "live" }, { kind: "autonomous_worker", runId });
      const status = exec.ok ? "submitted" : (exec.needs_reconcile ? "needs_reconcile" : "blocked");
      if (exec.ok) exitsSubmitted++;
      await svc.from("trade_proposals").update({ status: exec.ok ? "queued_auto" : "manual_review_required" }).eq("id", (prop as any).id);

      // Stamp "partial taken" ONLY on a submitted partial. A rejected or
      // blocked partial must NOT set this — doing so would permanently disable
      // this position's target branch and the runner would never bank profit.
      // The stamp is confirmed against the observed fill on a later run; this
      // is the optimistic half, deliberately gated on exec.ok.
      if (exec.ok && decision.action === "partial_target") {
        await svc.from("live_position_state").upsert({
          account_id: account, symbol, market,
          highest_price: decision.highestPrice,
          trailing_stop: decision.runnerStop ?? decision.trailingStop,
          partial_taken_at: new Date().toISOString(),
          partial_qty: qty,
          opened_at: positionOpenedAt,
          updated_at: new Date().toISOString(),
        }, { onConflict: "account_id,symbol" });
      }
      results.push({ market, symbol, qty, reason, status, error: exec.ok ? undefined : exec.error });
    }
  }

  await svc.from("decision_journal").insert({
    entry_type: "live_exit_run",
    summary: `Live exit monitor ${runId}: ${checked} live position(s), ${exitsSubmitted} protective SELL(s) submitted.`,
  } as any).then(() => {}, () => {});

  return { run_id: runId, positions_checked: checked, exits_submitted: exitsSubmitted, results };
}
