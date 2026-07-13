import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { getKiteHoldings, getKiteMargins } from "@/lib/kite";

export const dynamic = "force-dynamic";

// Real Zerodha holdings (INR). Degrades to a clear "reconnect" state when the
// daily token is stale, rather than erroring. Also returns account cash
// (margins.equity.net) and NAV so the India Live panel can show stat cards at
// parity with the US Live view.
export async function GET() {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

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

  // Liquid cash (buying power) — best-effort; a margins hiccup must not blank holdings.
  const marg = await getKiteMargins();
  const cash = marg.ok ? (marg.equityNet ?? null) : null;
  const holdingsValue = holdings.reduce((s: number, h: { value: number }) => s + (h.value ?? 0), 0);
  const nav = cash != null ? cash + holdingsValue : null;

  return NextResponse.json({ holdings, connected: true, currency: "INR", cash, nav });
}
