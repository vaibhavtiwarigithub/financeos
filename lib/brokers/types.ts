export type BrokerName = "robinhood" | "alpaca_paper" | "alpaca_live" | "internal" | "kite";

export interface BrokerHolding {
  symbol: string;
  qty: number;
  currentPrice: number;
  marketValue: number;
  costBasis?: number;
  unrealizedPnl?: number;
  unrealizedPnlPct?: number;
  side: "long" | "short";
  source: BrokerName;
}

export interface BrokerAccount {
  source: BrokerName;
  accountId?: string;      // broker account number/ID for per-account risk sections
  accountLabel?: string;   // human label e.g. "Robinhood Trading (605420660)"
  totalValue: number;
  cashBalance: number;
  buyingPower?: number;
  holdings: BrokerHolding[];
  fetchedAt: string;
  error?: string;
}
