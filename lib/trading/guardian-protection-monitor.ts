// Owner-armed software stops for manual positions. This is deliberately
// separate from the owner proposal-approval flow: approving a Guardian plan
// arms monitoring; it never sends a broker order at approval time.
import type { SupabaseClient } from "@supabase/supabase-js";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";
import { getQuote } from "@/lib/data/quotes";
import { executeApprovedOrder } from "@/lib/trading/execute-order";
import { isMarketOpenLive } from "@/lib/trading/market-calendar";
import { evaluateGuardianProtection, type GuardianPlanStatus } from "@/lib/trading/guardian-protection";

const AGENTIC_ACCOUNT_ID = "605420660";

type PlanRow = {
  id: number; account_id: string; symbol: string; qty: number; stop_price: number;
  status: GuardianPlanStatus; ledger_entry_id: number;
};

export interface GuardianMonitorResult {
  early_exit?: string;
  checked: number;
  submitted: number;
  results: Array<{ plan_id: number; symbol: string; status: string; error?: string }>;
}

/** US Robinhood exit quantity: preserve eligible fractional holdings, never round up. */
export function guardianUsExitQuantity(value: unknown): number | null {
  const raw = Number(value);
  if (!Number.isFinite(raw) || !(raw > 0)) return null;
  const qty = Math.floor(raw * 1_000_000) / 1_000_000;
  return qty > 0 ? qty : null;
}

export async function runGuardianProtectionMonitor(svc: SupabaseClient, runId: string): Promise<GuardianMonitorResult> {
  const base = { checked: 0, submitted: 0, results: [] as GuardianMonitorResult["results"] };
  // Both gates are intentionally checked before quote reads or any execution
  // work. A plan can be armed while disabled, but cannot act until the owner
  // enables the existing live-auto switch and the deployment flag is present.
  if (!AUTONOMOUS_LIVE_ENABLED) return { ...base, early_exit: "deployment_flag_inactive" };
  const { data: cfg, error: cfgError } = await svc.from("strategy_config")
    .select("live_auto_enabled, app_paused, security_locked, active_account_us").limit(1).maybeSingle();
  if (cfgError) throw new Error(`Guardian config read failed: ${cfgError.message}`);
  if (!cfg) return { ...base, early_exit: "no_config" };
  if ((cfg as any).app_paused || (cfg as any).security_locked) return { ...base, early_exit: "paused_or_locked" };
  if (!(cfg as any).live_auto_enabled) return { ...base, early_exit: "db_toggle_off" };
  if ((cfg as any).active_account_us !== AGENTIC_ACCOUNT_ID) return { ...base, early_exit: "agentic_account_not_active" };
  const session = await isMarketOpenLive("us");
  if (!session.open) return { ...base, early_exit: `market_closed:${session.reason}` };

  const { data: rows, error } = await svc.from("guardian_protection_plans")
    .select("id,account_id,symbol,qty,stop_price,status,ledger_entry_id")
    .eq("account_id", AGENTIC_ACCOUNT_ID).eq("status", "armed");
  if (error) throw new Error(`Guardian plan read failed: ${error.message}`);
  const result = { ...base };

  for (const plan of (rows ?? []) as PlanRow[]) {
    result.checked++;
    let price: number | null = null;
    try { const quote = await getQuote(plan.symbol, svc); price = !quote.stale ? quote.price ?? null : null; } catch { price = null; }
    const evaluation = evaluateGuardianProtection({ id: plan.id, symbol: plan.symbol, qty: plan.qty, stopPrice: plan.stop_price, status: plan.status }, price);
    if (evaluation.action !== "trigger") {
      result.results.push({ plan_id: plan.id, symbol: plan.symbol, status: evaluation.reason });
      continue;
    }

    // Atomic state claim prevents overlapping cron invocations from selling the
    // same manual holding twice. No proposal/order exists until this succeeds.
    const now = new Date().toISOString();
    const { data: claimed, error: claimError } = await svc.from("guardian_protection_plans")
      .update({ status: "triggering", triggered_at: now })
      .eq("id", plan.id).eq("status", "armed").select("id").maybeSingle();
    if (claimError || !claimed) {
      result.results.push({ plan_id: plan.id, symbol: plan.symbol, status: "skipped_duplicate", error: claimError?.message });
      continue;
    }
    await svc.from("guardian_protection_events").insert({
      plan_id: plan.id, event_type: "trigger_claimed", actor: "system", reason_code: "stop_breached",
      payload: { run_id: runId, quote_price: price, stop_price: plan.stop_price },
    });

    // The broker execution preflight remains authoritative for the individual
    // symbol. Do not silently leave a legitimate fractional Robinhood holding
    // unprotected merely because it is smaller than one whole share.
    const qty = guardianUsExitQuantity(plan.qty);
    if (qty == null) {
      await svc.from("guardian_protection_plans").update({ status: "armed", terminal_reason: "invalid_exit_quantity" }).eq("id", plan.id);
      result.results.push({ plan_id: plan.id, symbol: plan.symbol, status: "blocked", error: "invalid_exit_quantity" });
      continue;
    }
    const { data: proposal, error: proposalError } = await svc.from("trade_proposals").insert({
      symbol: plan.symbol, market: "us", side: "sell", order_type: "market", qty,
      status: "pending_review", execution_mode: "autonomous_live", auto_run_id: runId,
      auto_decided_at: now, account_number: AGENTIC_ACCOUNT_ID, price_at_proposal: price,
      price_source: "guardian_protection_monitor",
      thesis: `Guardian software stop: ${price} <= ${plan.stop_price}`,
      policy_snapshot: { version: "guardian_stage1", source: "manual_trade_guardian", guardian_plan_id: plan.id,
        ledger_entry_id: plan.ledger_entry_id, stop_price: plan.stop_price, trigger_price: price, owner_armed: true },
    }).select("id").single();
    if (proposalError || !proposal) {
      await svc.from("guardian_protection_plans").update({ status: "armed", terminal_reason: null }).eq("id", plan.id);
      result.results.push({ plan_id: plan.id, symbol: plan.symbol, status: "proposal_failed", error: proposalError?.message });
      continue;
    }
    const exec = await executeApprovedOrder(svc, { proposalId: (proposal as any).id, env: "live" }, { kind: "autonomous_worker", runId });
    // Once an exit proposal exists, never silently retry it. A failed gateway
    // check is an actionable manual-review condition, not permission to create
    // another SELL proposal on the next polling run.
    const nextStatus = exec.ok ? "trigger_submitted" : "trigger_needs_reconcile";
    await svc.from("guardian_protection_plans").update({ status: nextStatus, trigger_proposal_id: (proposal as any).id,
      terminal_reason: exec.ok ? null : exec.error }).eq("id", plan.id);
    await svc.from("guardian_protection_events").insert({ plan_id: plan.id,
      event_type: exec.ok ? "trigger_submitted" : "trigger_needs_reconcile", actor: "system",
      reason_code: exec.ok ? "broker_submitted" : "broker_blocked_or_unknown",
      payload: { run_id: runId, proposal_id: (proposal as any).id, order_id: exec.order_id ?? null, error: exec.ok ? null : exec.error },
    });
    await svc.from("trade_proposals").update({ status: exec.ok ? "queued_auto" : "manual_review_required" }).eq("id", (proposal as any).id);
    if (exec.ok) result.submitted++;
    result.results.push({ plan_id: plan.id, symbol: plan.symbol, status: exec.ok ? "submitted" : exec.needs_reconcile ? "needs_reconcile" : "blocked", error: exec.ok ? undefined : exec.error });
  }
  return result;
}
