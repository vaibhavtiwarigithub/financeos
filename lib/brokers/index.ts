import { createServiceClient } from "@/lib/supabase/service";
import { fetchAlpacaAccount } from "./alpaca";
import type { BrokerAccount, BrokerHolding } from "./types";

export type { BrokerAccount, BrokerHolding };
export type { BrokerName } from "./types";

// Internal paper positions from Supabase, scoped to a market (us | india).
// Pre-057 (no `market` column) the `.eq("market", …)` filter errors; we detect
// that and fall back to the unscoped query so US behaves exactly as before.
async function fetchInternalPaper(market: "us" | "india" = "us"): Promise<BrokerAccount> {
  const sb = createServiceClient();
  const fetchedAt = new Date().toISOString();

  // paper_positions real columns: symbol, qty, avg_cost, current_price,
  // opened_at — no status/avg_fill_price/unrealized_pnl(_pct) columns exist
  // (every row is open by definition; PnL is derived, not stored). The old
  // select queried nonexistent columns, Supabase errored, and this silently
  // returned zero paper holdings on the Risk Analytics page.
  // Phase 4/5: prefer the requested market pool; fall back to any row pre-057.
  let { data: portfolio } = await sb.from("paper_portfolio").select("nav, cash_balance").eq("market", market).limit(1).maybeSingle();
  if (!portfolio) ({ data: portfolio } = await sb.from("paper_portfolio").select("nav, cash_balance").limit(1).maybeSingle());

  // Market-scoped positions. If the column doesn't exist (pre-057) the query
  // errors → retry unscoped so the US book is unchanged.
  let { data: positions, error: posErr } = await sb
    .from("paper_positions").select("symbol, qty, avg_cost, current_price").eq("market", market);
  if (posErr) ({ data: positions } = await sb.from("paper_positions").select("symbol, qty, avg_cost, current_price"));

  const holdings: BrokerHolding[] = (positions ?? []).map((p: any) => {
    const qty = parseFloat(p.qty ?? 0);
    const avgCost = parseFloat(p.avg_cost ?? 0);
    const currentPrice = parseFloat(p.current_price ?? avgCost ?? 0);
    const marketValue = qty * currentPrice;
    const costBasis = qty * avgCost;
    return {
      symbol: p.symbol,
      qty,
      currentPrice,
      marketValue,
      costBasis,
      unrealizedPnl: marketValue - costBasis,
      unrealizedPnlPct: costBasis > 0 ? ((marketValue - costBasis) / costBasis) * 100 : 0,
      side: "long" as const,
      source: "internal" as const,
    };
  });

  return {
    source: "internal",
    totalValue:  parseFloat((portfolio as any)?.nav ?? 0),
    cashBalance: parseFloat((portfolio as any)?.cash_balance ?? 0),
    holdings,
    fetchedAt,
  };
}

// Fetch all connected accounts in parallel, scoped to a market.
// US pulls the paper pool + both Alpaca books (US brokers). India pulls only the
// ₹ paper pool — Alpaca/Robinhood are US-only, so blending them would mix $ and ₹.
export async function fetchAllAccounts(market: "us" | "india" = "us"): Promise<BrokerAccount[]> {
  const tasks = market === "india"
    ? [fetchInternalPaper("india")]
    : [fetchInternalPaper("us"), fetchAlpacaAccount(true), fetchAlpacaAccount(false)];
  const results = await Promise.allSettled(tasks);

  return results
    .map(r => r.status === "fulfilled" ? r.value : null)
    .filter((a): a is BrokerAccount => a !== null);
}

// Merge holdings across accounts (deduplicated by symbol per source)
export function mergeHoldings(accounts: BrokerAccount[]): BrokerHolding[] {
  return accounts.flatMap(a => a.holdings);
}

export { fetchAlpacaAccount };
