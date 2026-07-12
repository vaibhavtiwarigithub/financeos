import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";

// Cache live holdings for 5 minutes (RH positions don't change by the second)
let cache: { data: any[]; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ positions: cache.data, cached: true });
  }

  const TRADING_ACCOUNT = process.env.TRADING_ACCOUNT_NUMBER ?? "965848641";

  try {
    // Deterministic read-only snapshot via Robinhood MCP JSON-RPC (no subprocess).
    const accounts = await captureAllRobinhoodAccounts();
    const acct = accounts.find(a => a.accountId === TRADING_ACCOUNT);

    // Account missing or the capture failed for it → keep prior cache if any.
    if (!acct || acct.error) {
      if (cache) return NextResponse.json({ positions: cache.data, cached: true, stale: true });
      return NextResponse.json({ positions: [], stale: true });
    }

    const positions = acct.holdings.map(h => ({
      symbol: h.symbol,
      qty: h.qty,
      avg_cost: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : 0,
      current_price: h.currentPrice,
      name: h.symbol, // BrokerHolding carries no instrument name; ticker is the label
    }));

    cache = { data: positions, ts: Date.now() };
    return NextResponse.json({ positions, cached: false });
  } catch {
    if (cache) return NextResponse.json({ positions: cache.data, cached: true, stale: true });
    return NextResponse.json({ positions: [], stale: true });
  }
}
