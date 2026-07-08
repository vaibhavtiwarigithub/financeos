import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getBatchQuotes } from "@/lib/data/quotes";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const accountIds = new URL(req.url).searchParams.get("accounts")?.split(",").filter(Boolean);
  const svc = createServiceClient();

  let q = svc.from("live_account_snapshots").select("*").order("captured_at", { ascending: false });
  if (accountIds && accountIds.length > 0) q = q.in("account_id", accountIds);
  const { data: snaps } = await q;

  if (!snaps || snaps.length === 0) return NextResponse.json({ snaps: [], holdings: [] });

  // Merge positions from all selected accounts
  const allPositions: any[] = [];
  for (const snap of snaps) {
    const pos: any[] = Array.isArray(snap.positions_json) ? snap.positions_json : [];
    for (const p of pos) allPositions.push({ ...p, _account_id: snap.account_id });
  }

  const symbols = [...new Set(allPositions.map((p: any) => p.symbol).filter(Boolean))];

  let quotes: Record<string, any> = {};
  if (symbols.length > 0) {
    quotes = await getBatchQuotes(symbols, svc);
  }

  // Aggregate same symbol across accounts
  const symbolMap: Record<string, any> = {};
  for (const p of allPositions) {
    const sym = p.symbol;
    if (!symbolMap[sym]) {
      symbolMap[sym] = { ...p, _qty: 0, _cost: 0, _accounts: [] };
    }
    const qty = parseFloat(p.quantity ?? p.qty ?? "0");
    const avgCost = parseFloat(p.average_buy_price ?? p.avg_price ?? p.avg_cost ?? "0");
    symbolMap[sym]._qty += qty;
    symbolMap[sym]._cost += qty * avgCost;
    if (!symbolMap[sym]._accounts.includes(p._account_id)) symbolMap[sym]._accounts.push(p._account_id);
  }

  const holdings = Object.values(symbolMap).map((p: any) => {
    const q = quotes[p.symbol];
    const qty = p._qty;
    const avgCost = qty > 0 ? p._cost / qty : 0;
    // q.price is explicitly 0 (not null/undefined) for an "unavailable" quote,
    // so `q?.price ?? fallback` never triggered the fallback — every holding
    // with a failed quote showed currentValue $0 and a false "-100%" total
    // loss instead of falling back to avg cost (0% unrealized P&L, honest
    // "we don't know" instead of a wrong number).
    const currentPrice = (q?.price && q.price > 0) ? q.price : avgCost;
    const currentValue = qty * currentPrice;
    const costBasis = p._cost;
    const totalPnlDollar = currentValue - costBasis;
    const totalPnlPct = costBasis > 0 ? (totalPnlDollar / costBasis) * 100 : 0;
    return {
      symbol: p.symbol,
      name: p.name ?? p.symbol,
      qty,
      avgCost,
      currentPrice,
      currentValue,
      totalPnlDollar,
      totalPnlPct,
      dayChangePct: q?.changePct ?? null,
      dayChangeDollar: q?.change ? q.change * qty : null,
      priceSource: q?.source ?? "unavailable",
      accounts: p._accounts,
    };
  });

  return NextResponse.json({ snaps, holdings });
}
