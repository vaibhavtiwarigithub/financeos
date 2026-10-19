import type { BrokerAccount, BrokerHolding } from "./types";
import { getAlpacaCredentials } from "./alpaca-credentials";

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

  const creds = await getAlpacaCredentials(paper ? "paper" : "live");
  if (!creds) {
    const names = paper ? "ALPACA_PAPER_API_KEY + ALPACA_PAPER_API_SECRET" : "ALPACA_LIVE_API_KEY + ALPACA_LIVE_API_SECRET";
    return { source, totalValue: 0, cashBalance: 0, holdings: [], fetchedAt, error: `No complete API credential pair configured (${names})` };
  }

  try {
    const [account, positions, configuration] = await Promise.all([
      alpacaFetch("/v2/account", creds, paper),
      alpacaFetch("/v2/positions", creds, paper),
      alpacaFetch("/v2/account/configurations", creds, paper).catch(() => null),
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
      accountId: typeof account.id === "string" ? account.id : undefined,
      accountLabel: paper ? "Alpaca Paper" : "Alpaca Live",
      accountStatus: typeof account.status === "string" ? account.status : undefined,
      accountBlocked: typeof account.account_blocked === "boolean" ? account.account_blocked : undefined,
      tradingBlocked: typeof account.trading_blocked === "boolean" ? account.trading_blocked : undefined,
      transfersBlocked: typeof account.transfers_blocked === "boolean" ? account.transfers_blocked : undefined,
      shortingEnabled: typeof account.shorting_enabled === "boolean" ? account.shorting_enabled : undefined,
      accountState: {
        status: typeof account.status === "string" ? account.status : null,
        account_blocked: typeof account.account_blocked === "boolean" ? account.account_blocked : null,
        trading_blocked: typeof account.trading_blocked === "boolean" ? account.trading_blocked : null,
        transfers_blocked: typeof account.transfers_blocked === "boolean" ? account.transfers_blocked : null,
        shorting_enabled: typeof account.shorting_enabled === "boolean" ? account.shorting_enabled : null,
        fractional_trading: typeof configuration?.fractional_trading === "boolean" ? configuration.fractional_trading : null,
        suspend_trade: typeof configuration?.suspend_trade === "boolean" ? configuration.suspend_trade : null,
        closing_transactions_only: typeof configuration?.closing_transactions_only === "boolean" ? configuration.closing_transactions_only : null,
      },
      totalValue:   parseFloat(account.portfolio_value ?? account.equity ?? 0),
      cashBalance:  parseFloat(account.cash ?? account.buying_power ?? 0),
      holdings,
      fetchedAt,
    };
  } catch (err: unknown) {
    return { source, totalValue: 0, cashBalance: 0, holdings: [], fetchedAt, error: err instanceof Error ? err.message : String(err) };
  }
}
