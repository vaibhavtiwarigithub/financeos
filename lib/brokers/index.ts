import { createServiceClient } from "@/lib/supabase/service";
import { fetchAlpacaAccount } from "./alpaca";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";
import { getKiteHoldings, getKiteMargins } from "@/lib/kite";
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

// Fetch all live Robinhood accounts as BrokerAccount[], one per RH account number.
// Uses REST API so it works in Vercel serverless (no MCP session needed).
// Returns an error-flagged single account if the token is absent/expired.
export async function fetchRobinhoodBrokerAccounts(): Promise<BrokerAccount[]> {
  return captureAllRobinhoodAccounts();
  /* legacy private-REST implementation retained temporarily below for rollback reference
  const svc = createServiceClient();
  const fetchedAt = new Date().toISOString();

  const [{ accounts: rhAccounts, error: accErr }, { positions, error: posErr }] = await Promise.all([
    rhFetchAccounts(svc),
    rhFetchAllPositions(svc),
  ]);

  if (accErr || posErr || !rhAccounts.length) {
    return [{
      source: "robinhood",
      accountId: "unknown",
      accountLabel: "Robinhood",
      totalValue: 0,
      cashBalance: 0,
      holdings: [],
      fetchedAt,
      error: accErr ?? posErr ?? "No Robinhood accounts found — is the OAuth token active?",
    }];
  }

  // Group positions by account ID
  const positionsByAccount: Record<string, typeof positions> = {};
  for (const pos of positions) {
    (positionsByAccount[pos.accountId] ??= []).push(pos);
  }

  return rhAccounts.map(acc => {
    const accPositions = positionsByAccount[acc.id] ?? [];
    const holdings: BrokerHolding[] = accPositions.map(p => {
      const mv = p.qty * p.currentPrice;
      const cb = p.qty * p.avgCost;
      return {
        symbol: p.symbol,
        qty: p.qty,
        currentPrice: p.currentPrice,
        marketValue: mv,
        costBasis: cb,
        unrealizedPnl: mv - cb,
        unrealizedPnlPct: cb > 0 ? ((mv - cb) / cb) * 100 : 0,
        side: "long" as const,
        source: "robinhood" as const,
      };
    });

    const label = acc.id === "605420660" ? `Robinhood Trading (${acc.id})`
      : acc.id === "965848641" ? `Robinhood (${acc.id})`
      : `Robinhood ${acc.id}`;

    return {
      source: "robinhood" as const,
      accountId: acc.id,
      accountLabel: label,
      totalValue: acc.totalEquity,
      cashBalance: acc.cashBalance,
      holdings,
      fetchedAt,
    };
  }); */
}

// Fetch live Kite India account as a single BrokerAccount.
// Combines /user/margins (cash) + /portfolio/holdings (equity positions).
export async function fetchKiteBrokerAccount(): Promise<BrokerAccount> {
  const fetchedAt = new Date().toISOString();
  try {
    const [marginsRes, holdingsRes] = await Promise.all([
      getKiteMargins(),
      getKiteHoldings(),
    ]);

    if (!holdingsRes.ok) {
      return {
        source: "kite",
        accountId: "kite_india",
        accountLabel: "Kite India",
        totalValue: 0,
        cashBalance: 0,
        holdings: [],
        fetchedAt,
        error: holdingsRes.error ?? "Kite holdings unavailable",
      };
    }

    const holdings: BrokerHolding[] = ((holdingsRes.data ?? []) as any[]).map(h => {
      const qty = Number(h.quantity ?? h.t1_quantity ?? 0);
      const avgCost = Number(h.average_price ?? 0);
      const currentPrice = Number(h.last_price ?? avgCost);
      const mv = qty * currentPrice;
      const cb = qty * avgCost;
      const symbol = String(h.tradingsymbol ?? "");
      return {
        symbol: symbol.endsWith(".NS") || symbol.endsWith(".BO") ? symbol : `${symbol}.NS`,
        qty,
        currentPrice,
        marketValue: mv,
        costBasis: cb,
        unrealizedPnl: h.pnl != null ? Number(h.pnl) : mv - cb,
        unrealizedPnlPct: cb > 0 ? ((mv - cb) / cb) * 100 : 0,
        side: "long" as const,
        source: "kite" as const,
      };
    }).filter(h => h.qty > 0);

    const equityValue = holdings.reduce((s, h) => s + h.marketValue, 0);
    const cash = marginsRes.ok ? (marginsRes.equityNet ?? 0) : 0;

    return {
      source: "kite",
      accountId: "kite_india",
      accountLabel: "Kite India",
      totalValue: equityValue + cash,
      cashBalance: cash,
      holdings,
      fetchedAt,
    };
  } catch (e: any) {
    return {
      source: "kite",
      accountId: "kite_india",
      accountLabel: "Kite India",
      totalValue: 0,
      cashBalance: 0,
      holdings: [],
      fetchedAt,
      error: e?.message ?? String(e),
    };
  }
}

export { fetchAlpacaAccount };
