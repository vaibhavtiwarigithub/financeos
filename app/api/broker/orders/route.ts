import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { guardOrderRequest } from "@/lib/request-guards";
import { executeApprovedOrder } from "@/lib/trading/execute-order";

export const dynamic = "force-dynamic";

// Execution Gateway (spec Part A). NEVER cron-callable — every order requires a
// logged-in OWNER human click. The full submit-time invariant set lives in the
// shared lib/trading/execute-order.ts service (audit R13) so the manual owner
// path and the autonomous worker run the IDENTICAL gates; this route only does
// owner+CSRF auth, request parsing, and result→HTTP mapping.
export async function POST(req: NextRequest) {
  // Owner-only + CSRF/DNS-rebinding guard (this places real orders).
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;
  const guardErr = guardOrderRequest(req);
  if (guardErr) return guardErr;

  try {
    const body = await req.json();
    const { proposal_id, env, acceptLowQuality, acceptPortfolioRisk, overrideReason } = body as {
      proposal_id?: number; env?: "paper" | "live"; acceptLowQuality?: boolean; acceptPortfolioRisk?: boolean; overrideReason?: string;
    };
    // env must be explicit on an order-placing route — no silent paper default.
    if (env !== "paper" && env !== "live") {
      return NextResponse.json({ error: "env must be explicitly 'paper' or 'live'" }, { status: 400 });
    }
    if (!proposal_id) return NextResponse.json({ error: "proposal_id required" }, { status: 400 });

    const supabase = createServiceClient();
    const r = await executeApprovedOrder(
      supabase,
      { proposalId: proposal_id, env, acceptLowQuality, acceptPortfolioRisk, overrideReason },
      { kind: "owner" },
    );
    if (!r.ok) {
      return NextResponse.json(
        r.needs_reconcile ? { error: r.error, needs_reconcile: true } : { error: r.error },
        { status: r.status },
      );
    }
    return NextResponse.json({ success: true, order_id: r.order_id, broker_order_id: r.broker_order_id });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const supabase = createServiceClient();
  const status = new URL(req.url).searchParams.get("status");
  let q = supabase.from("broker_orders").select("*").order("created_at", { ascending: false }).limit(50);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ orders: data ?? [] });
}
