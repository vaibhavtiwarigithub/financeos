export type BrokerName = "robinhood" | "alpaca_paper" | "alpaca_live" | "internal";

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
  totalValue: number;
  cashBalance: number;
  holdings: BrokerHolding[];
  fetchedAt: string;
  error?: string;
}
