import { createServiceClient } from "@/lib/supabase/service";
import type { BrokerAccount, BrokerHolding } from "./types";

async function getAlpacaKeys(paper: boolean): Promise<{ key: string; secret: string } | null> {
  const sb = createServiceClient();
  const keyName   = paper ? "ALPACA_PAPER_API_KEY"    : "ALPACA_API_KEY";
  const secretName = paper ? "ALPACA_PAPER_API_SECRET" : "ALPACA_API_SECRET";

  const [{ data: k }, { data: s }] = await Promise.all([
    sb.from("api_key_vault").select("key_value").eq("key_name", keyName).single(),
    sb.from("api_key_vault").select("key_value").eq("key_name", secretName).single(),
  ]);

  const key    = (k as any)?.key_value ?? (paper ? process.env.ALPACA_PAPER_API_KEY    : process.env.ALPACA_API_KEY);
  const secret = (s as any)?.key_value ?? (paper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET);

  if (!key || !secret) return null;
  return { key, secret };
}

async function alpacaFetch(path: string, creds: { key: string; secret: string }, paper: boolean) {
  const base = paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
  const res = await fetch(`${base}${path}`, {
    headers: {
      "APCA-API-KEY-ID": creds.key,
      "APCA-API-SECRET-KEY": creds.secret,
    },
  });
  if (!res.ok) throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function fetchAlpacaAccount(paper: boolean): Promise<BrokerAccount> {
  const source = paper ? "alpaca_paper" : "alpaca_live";
  const fetchedAt = new Date().toISOString();

  const creds = await getAlpacaKeys(paper);
  if (!creds) {
    return { source, totalValue: 0, cashBalance: 0, holdings: [], fetchedAt, error: "No API keys — add ALPACA_PAPER_API_KEY + ALPACA_PAPER_API_SECRET to vault" };
  }

  try {
    const [account, positions] = await Promise.all([
      alpacaFetch("/v2/account", creds, paper),
      alpacaFetch("/v2/positions", creds, paper),
    ]);

    const holdings: BrokerHolding[] = (positions as any[]).map((p: any) => {
      const qty          = parseFloat(p.qty);
      const currentPrice = parseFloat(p.current_price ?? p.lastday_price ?? 0);
      const marketValue  = parseFloat(p.market_value ?? qty * currentPrice);
      const costBasis    = parseFloat(p.cost_basis ?? 0);
      const unrealizedPnl    = parseFloat(p.unrealized_pl ?? 0);
      const unrealizedPnlPct = costBasis > 0 ? unrealizedPnl / costBasis : 0;

      return {
        symbol: p.symbol,
        qty,
        currentPrice,
        marketValue,
        costBasis,
        unrealizedPnl,
        unrealizedPnlPct,
        side: (p.side === "short" ? "short" : "long") as "long" | "short",
        source,
      };
    });

    return {
      source,
      totalValue:   parseFloat(account.portfolio_value ?? account.equity ?? 0),
      cashBalance:  parseFloat(account.cash ?? account.buying_power ?? 0),
      holdings,
      fetchedAt,
    };
  } catch (err: unknown) {
    return { source, totalValue: 0, cashBalance: 0, holdings: [], fetchedAt, error: err instanceof Error ? err.message : String(err) };
  }
}
