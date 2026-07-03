import { createServiceClient } from "@/lib/supabase/service";
import { fetchAlpacaAccount } from "./alpaca";
import type { BrokerAccount, BrokerHolding } from "./types";

export type { BrokerAccount, BrokerHolding };
export type { BrokerName } from "./types";

// Internal paper positions from Supabase
async function fetchInternalPaper(): Promise<BrokerAccount> {
  const sb = createServiceClient();
  const fetchedAt = new Date().toISOString();

  const [{ data: portfolio }, { data: positions }] = await Promise.all([
    sb.from("paper_portfolio").select("nav, cash_balance").limit(1).single(),
    sb.from("paper_positions")
      .select("symbol, qty, avg_fill_price, current_price, unrealized_pnl, unrealized_pnl_pct")
      .eq("status", "open"),
  ]);

  const holdings: BrokerHolding[] = (positions ?? []).map((p: any) => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty ?? 0),
    currentPrice: parseFloat(p.current_price ?? p.avg_fill_price ?? 0),
    marketValue: parseFloat(p.qty ?? 0) * parseFloat(p.current_price ?? p.avg_fill_price ?? 0),
    costBasis: parseFloat(p.avg_fill_price ?? 0) * parseFloat(p.qty ?? 0),
    unrealizedPnl: parseFloat(p.unrealized_pnl ?? 0),
    unrealizedPnlPct: parseFloat(p.unrealized_pnl_pct ?? 0),
    side: "long" as const,
    source: "internal" as const,
  }));

  return {
    source: "internal",
    totalValue:  parseFloat((portfolio as any)?.nav ?? 0),
    cashBalance: parseFloat((portfolio as any)?.cash_balance ?? 0),
    holdings,
    fetchedAt,
  };
}

// Fetch all connected accounts in parallel
export async function fetchAllAccounts(): Promise<BrokerAccount[]> {
  const results = await Promise.allSettled([
    fetchInternalPaper(),
    fetchAlpacaAccount(true),   // paper
    fetchAlpacaAccount(false),  // live
  ]);

  return results
    .map(r => r.status === "fulfilled" ? r.value : null)
    .filter((a): a is BrokerAccount => a !== null);
}

// Merge holdings across accounts (deduplicated by symbol per source)
export function mergeHoldings(accounts: BrokerAccount[]): BrokerHolding[] {
  return accounts.flatMap(a => a.holdings);
}

export { fetchAlpacaAccount };
