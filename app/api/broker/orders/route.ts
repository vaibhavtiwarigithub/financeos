import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getActiveBroker } from "@/lib/brokers/registry";
import { isIndia } from "@/lib/india-data";

export const dynamic = "force-dynamic";

// Execution Gateway (spec Part A). NEVER cron-callable — every order requires
// a logged-in human click. Live orders additionally require trading_enabled.
export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await req.json();
    const { proposal_id, env } = body as { proposal_id?: number; env?: "paper" | "live" };
    const orderEnv: "paper" | "live" = env === "live" ? "live" : "paper";
    if (!proposal_id) return NextResponse.json({ error: "proposal_id required" }, { status: 400 });

    const supabase = createServiceClient();

    if (orderEnv === "live") {
      const { data: cfg } = await supabase.from("strategy_config").select("trading_enabled").limit(1).maybeSingle();
      if (!(cfg as any)?.trading_enabled) {
        return NextResponse.json({ error: "Live trading is disabled (strategy_config.trading_enabled = false)" }, { status: 403 });
      }
    }

    const { data: proposal } = await supabase.from("trade_proposals").select("*").eq("id", proposal_id).maybeSingle();
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if ((proposal as any).status !== "approved") {
      return NextResponse.json({ error: `Proposal status is '${(proposal as any).status}', must be 'approved'` }, { status: 400 });
    }
    if ((proposal as any).approval_expires_at && new Date((proposal as any).approval_expires_at) < new Date()) {
      return NextResponse.json({ error: "Proposal approval has expired" }, { status: 400 });
    }

    // Idempotency: refuse a duplicate active order for the same proposal.
    const { data: activeOrder } = await supabase.from("broker_orders").select("id")
      .eq("proposal_id", proposal_id).in("status", ["pending_submit", "submitted", "partially_filled"]).maybeSingle();
    if (activeOrder) return NextResponse.json({ error: `An active order already exists for this proposal (id ${(activeOrder as any).id})` }, { status: 409 });

    const symbol = (proposal as any).symbol;
    const side = (proposal as any).side === "sell" ? "sell" : "buy";
    const qty = (proposal as any).qty;
    const market: "us" | "india" = isIndia(symbol) ? "india" : "us";

    const broker = await getActiveBroker(supabase, market);
    if (orderEnv === "live" && !broker.envs.includes("live")) {
      return NextResponse.json({ error: `${broker.id} does not support live orders` }, { status: 400 });
    }
    if (!(await broker.isConfigured())) {
      return NextResponse.json({ error: `${broker.id} has no API keys configured — add them in Admin → Vault` }, { status: 400 });
    }

    const { data: orderRow } = await supabase.from("broker_orders").insert({
      proposal_id, market, broker: broker.id, broker_env: orderEnv,
      symbol, side, qty, order_type: "market", status: "pending_submit", approved_by_user: true,
    }).select("id").single();
    const orderId = (orderRow as any)?.id;

    const result = await broker.submitOrder({ symbol, side, qty, env: orderEnv });
    if (!result.ok) {
      await supabase.from("broker_orders").update({ status: "error", error: result.error }).eq("id", orderId);
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    await supabase.from("broker_orders").update({
      status: "submitted", broker_order_id: result.brokerOrderId, submitted_at: new Date().toISOString(), raw_last_state: result.raw,
    }).eq("id", orderId);

    await supabase.from("decision_journal").insert({
      entry_type: "broker_order", symbol,
      summary: `${broker.id} ${orderEnv.toUpperCase()} order: ${side} ${qty} × ${symbol} (proposal ${proposal_id}) → order ${result.brokerOrderId}`,
      calculations: { proposal_id, broker: broker.id, env: orderEnv, side, qty, broker_order_id: result.brokerOrderId },
      has_verified_facts: true, resolved: false,
    });

    return NextResponse.json({ success: true, order_id: orderId, broker_order_id: result.brokerOrderId });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createServiceClient();
  const status = new URL(req.url).searchParams.get("status");
  let q = supabase.from("broker_orders").select("*").order("created_at", { ascending: false }).limit(50);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ orders: data ?? [] });
}
