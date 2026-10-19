import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { getKiteHoldings, getKiteMargins, getKiteMutualFundHoldings, getKitePositions } from "@/lib/kite";
import { buildCoinPortfolio } from "@/lib/brokers/coin";

export const dynamic = "force-dynamic";

// Real Zerodha holdings (INR). Degrades to a clear "reconnect" state when the
// daily token is stale, rather than erroring. Also returns account cash
// (margins.equity.net) and NAV so the India Live panel can show stat cards at
// parity with the US Live view.
export async function GET() {
  const ownerGate = await requireOwner();
  if (ownerGate) return ownerGate;

  const [res, marg, coinRes, positionsRes] = await Promise.all([
    getKiteHoldings(),
    getKiteMargins(),
    getKiteMutualFundHoldings(),
    getKitePositions(),
  ]);
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

  // Keep same-day positions separate from delivery holdings. Kite's `net`
  // positions can include carry-forward quantities; neither view is combined
  // with delivery holdings for NAV, preventing accidental double counting.
  const dayPositions = Array.isArray(positionsRes.data?.day) ? positionsRes.data.day : [];
  const positions = dayPositions
    .filter((p: any) => Number(p.quantity ?? 0) !== 0)
    .map((p: any) => ({
      symbol: `${p.tradingsymbol}.${p.exchange === "BSE" ? "BO" : "NS"}`,
      tradingsymbol: p.tradingsymbol,
      exchange: p.exchange,
      product: p.product ?? null,
      qty: Number(p.quantity ?? 0),
      buy_price: Number(p.average_price ?? p.buy_price ?? 0),
      last_price: Number(p.last_price ?? 0),
      pnl: Number(p.pnl ?? 0),
      value: Math.abs(Number(p.last_price ?? 0) * Number(p.quantity ?? 0)),
    }));

  // Liquid cash (buying power) — best-effort; a margins hiccup must not blank holdings.
  const cash = marg.ok ? (marg.equityNet ?? null) : null;
  const holdingsValue = holdings.reduce((s: number, h: { value: number }) => s + (h.value ?? 0), 0);
  const nav = cash != null ? cash + holdingsValue : null;

  // Coin is independent from the equity portfolio. A Coin failure must not
  // blank NSE holdings; a successful empty response is still available=true.
  const normalizedCoin = coinRes.ok ? buildCoinPortfolio(coinRes.data ?? []) : null;
  const coin = normalizedCoin
    ? {
        available: true,
        holdings: normalizedCoin.holdings,
        holding_count: normalizedCoin.holdingCount,
        valuation_complete: normalizedCoin.valuationComplete,
        total_invested: normalizedCoin.totalInvested,
        total_value: normalizedCoin.totalValue,
        total_pnl: normalizedCoin.totalPnl,
        error: null,
      }
    : {
        available: false,
        holdings: [],
        holding_count: 0,
        valuation_complete: false,
        total_invested: null,
        total_value: null,
        total_pnl: null,
        error: coinRes.error ?? "Coin holdings unavailable",
      };
  const combinedNav = nav != null && coin.available && coin.valuation_complete && coin.total_value != null
    ? nav + coin.total_value
    : null;

  return NextResponse.json({
    holdings,
    positions,
    positions_available: positionsRes.ok,
    positions_error: positionsRes.ok ? null : positionsRes.error,
    connected: true,
    currency: "INR",
    cash,
    nav,
    combined_nav: combinedNav,
    coin,
    fetched_at: new Date().toISOString(),
  });
}
