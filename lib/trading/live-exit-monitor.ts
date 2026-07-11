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

// Conservative default protective bands (owner-tunable later via strategy_config).
const STOP_PCT = 0.08;     // sell if price falls 8% below weighted entry
const TARGET_PCT = 0.20;   // take profit at +20%
const MAX_AGE_DAYS = 15;   // time stop

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
  const { data: cfg } = await svc.from("strategy_config")
    .select("live_auto_enabled, app_paused, security_locked, active_account_us, active_account_india").limit(1).maybeSingle();
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

    const { data: fills } = await svc.from("broker_orders")
      .select("symbol, side, filled_qty, qty, avg_fill_price, created_at, status")
      .eq("broker_env", "live").eq("market", market).eq("status", "filled")
      .in("broker", mc.brokers);

    type Pos = { qty: number; costQty: number; costSum: number; firstBuy: number };
    const bySymbol: Record<string, Pos> = {};
    for (const o of (fills ?? []) as any[]) {
      const q = Number(o.filled_qty ?? o.qty ?? 0);
      if (!Number.isFinite(q) || q <= 0) continue;
      const p = (bySymbol[o.symbol] ??= { qty: 0, costQty: 0, costSum: 0, firstBuy: Date.now() });
      if (o.side === "sell") { p.qty -= q; }
      else {
        p.qty += q;
        const px = Number(o.avg_fill_price);
        if (Number.isFinite(px) && px > 0) { p.costQty += q; p.costSum += q * px; }
        const t = o.created_at ? Date.parse(o.created_at) : Date.now();
        if (Number.isFinite(t)) p.firstBuy = Math.min(p.firstBuy, t);
      }
    }

    for (const [symbol, p] of Object.entries(bySymbol)) {
      if (p.qty < 1) continue;
      checked++;
      const entry = p.costQty > 0 ? p.costSum / p.costQty : NaN;
      if (!Number.isFinite(entry) || entry <= 0) continue;

      const pr = await priceFor(market, symbol, svc);
      if (!pr.ok) continue;
      const price = pr.price;

      const ageDays = (Date.now() - p.firstBuy) / 86_400_000;
      let reason: string | null = null;
      if (price <= entry * (1 - STOP_PCT)) reason = `stop: ${price.toFixed(2)} <= ${(entry * (1 - STOP_PCT)).toFixed(2)} (entry ${entry.toFixed(2)})`;
      else if (price >= entry * (1 + TARGET_PCT)) reason = `target: ${price.toFixed(2)} >= ${(entry * (1 + TARGET_PCT)).toFixed(2)}`;
      else if (ageDays > MAX_AGE_DAYS) reason = `time stop: age ${ageDays.toFixed(0)}d > ${MAX_AGE_DAYS}d`;
      if (!reason) continue;

      const qty = Math.floor(p.qty);
      const { data: prop, error: propErr } = await svc.from("trade_proposals").insert({
        symbol, market, side: "sell", order_type: "market", qty,
        status: "pending_review", execution_mode: "autonomous_live",
        auto_run_id: runId, auto_decided_at: new Date().toISOString(),
        price_at_proposal: price, price_source: "live_exit_monitor",
        thesis: `Protective exit — ${reason}`,
      }).select("id").single();
      if (propErr || !prop) {
        results.push({ market, symbol, qty, reason, status: "proposal_failed", error: propErr?.message });
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
