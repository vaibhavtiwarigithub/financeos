import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAlpacaOrder } from "@/lib/brokers/alpaca-orders";
import { fetchAlpacaAccount } from "@/lib/brokers/alpaca";

export const dynamic = "force-dynamic";

// Execution Gateway (spec Part A) — polls Alpaca for order-status updates on
// every in-flight broker_order, then reconciles positions and raises an alert
// on a mismatch. Cron-only (never places or cancels an order itself).
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get("x-cron-secret");
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: openOrders } = await supabase.from("broker_orders").select("*")
    .in("status", ["submitted", "partially_filled"]).eq("broker", "alpaca");

  let updated = 0, filled = 0;
  for (const order of (openOrders ?? []) as any[]) {
    if (!order.broker_order_id) continue;
    const env = order.broker_env === "live" ? "live" : "paper";
    const res = await getAlpacaOrder(order.broker_order_id, env);
    if (!res.ok || !res.status) continue;

    await supabase.from("broker_orders").update({
      status: res.status, filled_qty: res.filledQty ?? order.filled_qty,
      avg_fill_price: res.avgFillPrice ?? order.avg_fill_price, raw_last_state: res.raw,
      closed_at: ["filled", "canceled", "expired", "rejected"].includes(res.status) ? new Date().toISOString() : null,
    }).eq("id", order.id);
    updated++;

    if (res.status === "filled") {
      filled++;
      await supabase.from("decision_journal").insert({
        entry_type: "broker_order_filled", symbol: order.symbol,
        summary: `Alpaca order filled: ${order.side} ${res.filledQty ?? order.qty} × ${order.symbol} @ avg ${res.avgFillPrice ?? "?"}`,
        calculations: { broker_order_id: order.broker_order_id, filled_qty: res.filledQty, avg_fill_price: res.avgFillPrice },
        has_verified_facts: true, resolved: true, resolved_at: new Date().toISOString(),
      });
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
  if (mismatches.length > 0) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    await fetch(`${appUrl}/api/alerts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ severity: "warn", category: "broker", title: "Broker position mismatch detected", detail: mismatches.join(" · "), auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString() }),
    }).catch(() => {});
  }

  return NextResponse.json({ success: true, updated, filled, mismatches });
}
