import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";

// The agentic trading account (the ONLY account permitted for order placement).
const AGENTIC_ACCOUNT = "605420660";

let cache: { data: any; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function GET(_req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json(cache.data);
    }

    // Deterministic read-only snapshot via Robinhood MCP JSON-RPC (no subprocess).
    const accounts = await captureAllRobinhoodAccounts();
    const acct = accounts.find(a => a.accountId === AGENTIC_ACCOUNT);

    // Not connected / capture failed for this account → auth_required (unchanged shape).
    if (!acct || acct.error) {
      return NextResponse.json({ error: "auth_required", positions: [], equity: 0, buying_power: 0 });
    }

    const positions = acct.holdings.map(h => {
      const costBasis = h.costBasis ?? 0;
      const pnl = h.unrealizedPnl ?? (h.marketValue - costBasis);
      return {
        symbol: h.symbol,
        qty: h.qty,
        avg_cost: costBasis > 0 && h.qty > 0 ? costBasis / h.qty : 0,
        current_price: h.currentPrice,
        pnl,
        pnl_pct: h.unrealizedPnlPct ?? (costBasis > 0 ? (pnl / costBasis) * 100 : 0),
      };
    });

    // Account-level return from aggregate cost basis vs. market value.
    const totalCost = acct.holdings.reduce((s, h) => s + (h.costBasis ?? 0), 0);
    const totalMktVal = acct.holdings.reduce((s, h) => s + h.marketValue, 0);
    const total_return_pct = totalCost > 0 ? ((totalMktVal - totalCost) / totalCost) * 100 : 0;

    const data = {
      equity: acct.totalValue,
      buying_power: acct.buyingPower ?? acct.cashBalance ?? 0,
      total_return_pct,
      positions,
    };

    cache = { data, ts: Date.now() };
    return NextResponse.json(data);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg, positions: [], equity: 0, buying_power: 0 }, { status: 500 });
  }
}
