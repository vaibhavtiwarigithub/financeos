import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getKiteHoldings } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Real Zerodha holdings (INR). Degrades to a clear "reconnect" state when the
// daily token is stale, rather than erroring.
export async function GET() {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await getKiteHoldings();
  if (!res.ok) return NextResponse.json({ holdings: [], connected: false, error: res.error });

  const holdings = (res.data ?? []).map((h: any) => ({
    symbol: `${h.tradingsymbol}.${h.exchange === "BSE" ? "BO" : "NS"}`,
    tradingsymbol: h.tradingsymbol,
    exchange: h.exchange,
    qty: h.quantity,
    avg_price: h.average_price,
    last_price: h.last_price,
    pnl: h.pnl,
    value: (h.last_price ?? 0) * (h.quantity ?? 0),
  }));
  return NextResponse.json({ holdings, connected: true, currency: "INR" });
}
