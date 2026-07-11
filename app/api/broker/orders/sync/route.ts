import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getBroker } from "@/lib/brokers/registry";
import { fetchAlpacaAccount } from "@/lib/brokers/alpaca";
import { getKiteHoldings } from "@/lib/kite";
import { verifyCronSecret } from "@/lib/auth/cron";
import { emitAlert } from "@/lib/alerts/emit";
import { resolveIssue } from "@/lib/system-health";
import { checkKillSwitches } from "@/lib/kill-switches";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Execution Gateway (spec Part A) — polls Alpaca for order-status updates on
// every in-flight broker_order, then reconciles positions and raises an alert
// on a mismatch. Cron-only (never places or cancels an order itself).
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  // Iterates DISTINCT brokers present in open orders (Part 2d) — so an
  // Alpaca order and a Kite order can both be in-flight and sync correctly.
  const { data: openOrders } = await supabase.from("broker_orders").select("*")
    .in("status", ["submitted", "partially_filled", "unknown_needs_reconcile"]);

  let updated = 0, filled = 0;
  for (const order of (openOrders ?? []) as any[]) {
    if (!order.broker_order_id) continue;
    const broker = getBroker(order.broker ?? "alpaca");
    if (!broker) continue;
    const env = order.broker_env === "live" ? "live" : "paper";
    const res = await broker.getOrder(order.broker_order_id, env);
    if (!res.ok || !res.status) continue;

    await supabase.from("broker_orders").update({
      status: res.status, filled_qty: res.filledQty ?? order.filled_qty,
      avg_fill_price: res.avgFillPrice ?? order.avg_fill_price, raw_last_state: res.raw,
      closed_at: ["filled", "canceled", "expired", "rejected"].includes(res.status) ? new Date().toISOString() : null,
    }).eq("id", order.id);
    updated++;

    if (res.status === "filled") {
      filled++;
      // Write the real fill back to the originating proposal so the UI/ledger
      // reflect the actual price/qty (not just the broker_orders row).
      if (order.proposal_id) {
        await supabase.from("trade_proposals").update({
          status: "executed",
          fill_price: res.avgFillPrice ?? null,
          fill_qty: res.filledQty ?? order.qty,
          filled_at: new Date().toISOString(),
        }).eq("id", order.proposal_id);
      }
      await supabase.from("decision_journal").insert({
        entry_type: "broker_order_filled", symbol: order.symbol, market: order.market ?? null,
        summary: `${broker.id} order filled: ${order.side} ${res.filledQty ?? order.qty} × ${order.symbol} @ avg ${res.avgFillPrice ?? "?"}`,
        calculations: { broker_order_id: order.broker_order_id, filled_qty: res.filledQty, avg_fill_price: res.avgFillPrice, proposal_id: order.proposal_id ?? null },
        has_verified_facts: true, resolved: true, resolved_at: new Date().toISOString(),
      });
      // Any needs-reconcile alert for this order is now moot — the order confirmed.
      await resolveIssue(`order-needs-reconcile:${order.id}`, supabase);
    }
  }

  // Reconciliation: compare filled broker_orders aggregate per symbol/env
  // against Alpaca's actual reported positions; alert on material mismatch.
  const mismatches: string[] = [];
  for (const env of ["paper", "live"] as const) {
    const account = await fetchAlpacaAccount(env === "paper");
    if (account.error) continue;
    const { data: filledOrders } = await supabase.from("broker_orders")
      .select("symbol, side, filled_qty").eq("broker", "alpaca").eq("broker_env", env).eq("status", "filled");
    const netBySymbol: Record<string, number> = {};
    for (const o of (filledOrders ?? []) as any[]) {
      const sign = o.side === "buy" ? 1 : -1;
      netBySymbol[o.symbol] = (netBySymbol[o.symbol] ?? 0) + sign * Number(o.filled_qty ?? 0);
    }
    for (const [symbol, netQty] of Object.entries(netBySymbol)) {
      const holding = account.holdings.find(h => h.symbol === symbol);
      const actualQty = holding?.qty ?? 0;
      if (Math.abs(actualQty - netQty) > 1) mismatches.push(`${symbol} (${env}): our ledger says ${netQty}, Alpaca says ${actualQty}`);
    }
  }
  // Kite (India) reconciliation — was entirely missing before: only Alpaca's
  // holdings were ever checked, so an India ledger/reality mismatch had no
  // detection path at all. Kite is live-only (no paper env).
  {
    const holdings = await getKiteHoldings(supabase);
    if (holdings.ok && Array.isArray(holdings.data)) {
      const { data: filledOrders } = await supabase.from("broker_orders")
        .select("symbol, side, filled_qty").eq("broker", "kite").eq("broker_env", "live").eq("status", "filled");
      const netBySymbol: Record<string, number> = {};
      for (const o of (filledOrders ?? []) as any[]) {
        const sign = o.side === "buy" ? 1 : -1;
        netBySymbol[o.symbol] = (netBySymbol[o.symbol] ?? 0) + sign * Number(o.filled_qty ?? 0);
      }
      for (const [symbol, netQty] of Object.entries(netBySymbol)) {
        const bare = symbol.replace(/\.(NS|BO)$/i, "");
        const holding = holdings.data.find((h: any) => h.tradingsymbol === bare);
        const actualQty = holding?.quantity ?? 0;
        if (Math.abs(actualQty - netQty) > 1) mismatches.push(`${symbol} (kite/live): our ledger says ${netQty}, Kite says ${actualQty}`);
      }
    }
  }

  if (mismatches.length > 0) {
    await emitAlert({ severity: "warn", category: "broker", title: "Broker position mismatch detected", detail: mismatches.join(" · "), auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() });
  }

  // R16 cancel-on-kill: if a market's kill switch is tripped, CANCEL its resting
  // live orders (a breached limit must stop in-flight exposure, not only block
  // new orders). Bounded protective control — only cancels, never places.
  const canceled: string[] = [];
  for (const mkt of ["us", "india"] as const) {
    const ks = await checkKillSwitches(supabase, mkt);
    if (ks.safe) continue;
    // Cancel BUY orders only. Protective SELLs (exit-monitor stop/target orders)
    // must NOT be canceled when a kill switch trips — killing them increases risk
    // by leaving open long positions unprotected.
    const { data: resting } = await supabase.from("broker_orders").select("*")
      .eq("market", mkt).eq("broker_env", "live").eq("side", "buy")
      .in("status", ["pending_submit", "submitted", "partially_filled"]);
    if (!resting || resting.length === 0) continue;
    for (const o of resting as any[]) {
      if (!o.broker_order_id) continue;
      const broker = getBroker(o.broker ?? "");
      if (!broker) continue;
      const c = await broker.cancelOrder(o.broker_order_id, "live");
      if (c.ok) {
        await supabase.from("broker_orders").update({ status: "canceled", closed_at: new Date().toISOString() }).eq("id", o.id);
        canceled.push(`${o.symbol} #${o.id}`);
      }
    }
    await emitAlert({
      severity: "critical", category: "trading",
      title: `Kill switch tripped (${mkt.toUpperCase()}) — canceling resting live orders`,
      detail: `${ks.reason}. Canceled: ${canceled.length ? canceled.join(", ") : "none confirmed (check broker)"}.`,
    });
  }

  return NextResponse.json({ success: true, updated, filled, mismatches, canceled });
}
