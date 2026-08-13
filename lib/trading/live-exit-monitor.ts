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
  if (!(cfg as any).live_auto_enabled) return early("db_toggle_off");

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

    for (const p of positions) {
      const symbol = p.symbol;
      if (p.qty < 1) continue;
      checked++;

      const pr = await priceFor(market, symbol, svc);
      if (!pr.ok) continue;
      const price = pr.price;

      let reason: string | null = null;
      if (price <= p.stopPrice) reason = `stop: ${price.toFixed(2)} <= ${p.stopPrice.toFixed(2)} (entry ${p.avgEntry.toFixed(2)})`;
      else if (price >= p.targetPrice) reason = `target: ${price.toFixed(2)} >= ${p.targetPrice.toFixed(2)}`;
      else {
        const ageDays = tradingWeekdaysBetween(new Date(p.firstBuyAt), new Date());
        if (ageDays > p.horizonDays) reason = `time stop: age ${ageDays} market days > ${p.horizonDays}d`;
      }
      if (!reason) continue;

      const qty = Math.floor(p.qty);

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
      results.push({ market, symbol, qty, reason, status, error: exec.ok ? undefined : exec.error });
    }
  }

  await svc.from("decision_journal").insert({
    entry_type: "live_exit_run",
    summary: `Live exit monitor ${runId}: ${checked} live position(s), ${exitsSubmitted} protective SELL(s) submitted.`,
  } as any).then(() => {}, () => {});

  return { run_id: runId, positions_checked: checked, exits_submitted: exitsSubmitted, results };
}
