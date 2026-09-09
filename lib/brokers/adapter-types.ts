// Broker adapter interface for the EXECUTION GATEWAY (order submit/status/cancel).
// Distinct from types.ts (holdings-aggregation types for the read-only dashboard
// account view) — this is the write-path adapter contract. Swapping/adding an
// execution broker means one new file implementing this interface + one entry
// in registry.ts. Zero route/UI changes.
//
// Safety unchanged: trading_enabled + human click + confirm sit ABOVE this
// layer in every caller — adapters never gate, they only execute.

// needsReconcile: the submit outcome is AMBIGUOUS (possible-success timeout, or
// a success with no parseable order id). Callers must NOT auto-retry — the
// order may already exist at the broker; reconcile before any resubmission.
export interface BrokerOrderResult { ok: boolean; brokerOrderId?: string; raw?: any; error?: string; needsReconcile?: boolean }
export interface BrokerOrderState {
  ok: boolean;
  status?: "submitted" | "partially_filled" | "filled" | "canceled" | "rejected" | "expired";
  filledQty?: number; avgFillPrice?: number; raw?: any; error?: string;
}

export interface BrokerPreflightInput {
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  type: "market" | "limit" | "protective_stop" | "protective_target";
  limitPrice?: number;
  env: "paper" | "live";
}

export interface BrokerInstrumentCapability {
  broker: string; accountId: string; env: "paper" | "live"; market: "us" | "india";
  requestedSymbol: string; canonicalSymbol: string | null; instrumentId: string | null;
  side: "buy" | "sell"; orderType: BrokerPreflightInput["type"];
  allowed: boolean; active: boolean; buyAllowed: boolean; sellAllowed: boolean; closeOnly: boolean;
  fractionalAllowed: boolean; lotSize: number | null; tickSize: number | null;
  checkedAt: string; expiresAt: string; source: string; reasonCode: string | null; rawFingerprint: string;
}

export interface BrokerAdapter {
  id: string;                 // "alpaca" | "kite" | ...
  market: "us" | "india";
  envs: ("paper" | "live")[]; // which environments this broker supports
  isConfigured(): Promise<boolean>;
  preflightOrder(o: BrokerPreflightInput): Promise<BrokerInstrumentCapability>;
  submitOrder(o: { symbol: string; side: "buy" | "sell"; qty: number; type?: "market" | "limit"; limitPrice?: number; env: "paper" | "live" }): Promise<BrokerOrderResult>;
  getOrder(brokerOrderId: string, env: "paper" | "live"): Promise<BrokerOrderState>;
  cancelOrder(brokerOrderId: string, env: "paper" | "live"): Promise<{ ok: boolean; error?: string }>;
}
