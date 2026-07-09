import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getKiteHoldings } from "@/lib/kite";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// India (Zerodha Kite) live holdings — read-only, owner-gated. Powers the India
// view of the Live Holdings tab (the US view uses /api/portfolio/live-holdings).
// Normalizes Kite's holdings shape to the same {symbol, qty, avg_cost,
// current_price} the UI table expects. Fail-soft: returns positions:[] with a
// reason when Kite isn't connected / the daily token expired.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();

  let res: any;
  try { res = await getKiteHoldings(svc); }
  catch (e: any) { return NextResponse.json({ ok: false, error: e?.message ?? "kite_error", positions: [] }); }

  if (!res?.ok) return NextResponse.json({ ok: false, error: res?.error ?? "Kite not connected", positions: [] });

  const raw: any[] = Array.isArray(res.data) ? res.data : (res.data?.data ?? []);
  const positions = raw.map((h: any) => ({
    symbol: h.tradingsymbol ?? h.symbol,
    name: h.tradingsymbol ?? h.symbol,
    qty: Number(h.quantity ?? h.qty ?? 0),
    avg_cost: Number(h.average_price ?? h.avg_cost ?? 0),
    current_price: Number(h.last_price ?? h.current_price ?? 0),
  })).filter((p: any) => p.symbol && p.qty);

  return NextResponse.json({ ok: true, positions });
}
