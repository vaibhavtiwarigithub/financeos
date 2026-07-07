import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { placeEquityOrder } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Places a REAL Zerodha order. Safety model, deliberately human-in-the-loop:
//  - Authenticated user only (never cron/agent-triggered).
//  - Requires an explicit confirm:true in the body — a bare call won't fire.
//  - This is invoked from a user click after reviewing the order, mirroring the
//    "human approves every real order" principle used on the US side. Nothing
//    auto-executes India orders.
export async function POST(req: NextRequest) {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { symbol, transaction_type, quantity, order_type, price, confirm } = body as {
    symbol?: string; transaction_type?: "BUY" | "SELL"; quantity?: number;
    order_type?: "MARKET" | "LIMIT"; price?: number; confirm?: boolean;
  };

  if (confirm !== true) {
    return NextResponse.json({ error: "confirm:true required — this places a real order with real money." }, { status: 400 });
  }
  if (!symbol || !transaction_type || !quantity || quantity < 1) {
    return NextResponse.json({ error: "symbol, transaction_type (BUY/SELL) and quantity (>=1) are required." }, { status: 400 });
  }
  if ((order_type ?? "MARKET") === "LIMIT" && (price == null || price <= 0)) {
    return NextResponse.json({ error: "price required for a LIMIT order." }, { status: 400 });
  }

  const res = await placeEquityOrder({
    tradingsymbol: symbol,
    transaction_type,
    quantity: Math.floor(quantity),
    order_type: order_type ?? "MARKET",
    price,
    product: "CNC",
  });

  // Best-effort audit trail (real orders should always leave a record).
  try {
    const svc = createServiceClient();
    await svc.from("decision_journal").insert({
      entry_type: "kite_order",
      symbol, market: "india", // Kite is India-only
      summary: `Kite ${transaction_type} ${quantity} ${symbol} (${order_type ?? "MARKET"}${price ? ` @ ₹${price}` : ""}) → ${res.ok ? `order ${res.data?.order_id}` : `FAILED: ${res.error}`}`,
      calculations: { transaction_type, quantity, order_type: order_type ?? "MARKET", price: price ?? null, order_id: res.data?.order_id ?? null },
      has_verified_facts: true,
      resolved: res.ok,
    });
  } catch { /* audit is best-effort */ }

  if (!res.ok) return NextResponse.json({ success: false, error: res.error }, { status: 502 });
  return NextResponse.json({ success: true, order_id: res.data?.order_id });
}
