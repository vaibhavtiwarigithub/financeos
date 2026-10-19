export type KiteGttForCoverage = {
  id: number | string;
  status: string;
  expires_at?: string | null;
  condition?: { tradingsymbol?: string; trigger_values?: number[] };
  orders?: Array<{ transaction_type?: string; quantity?: number; order_type?: string; price?: number }>;
};

export type IndiaHoldingForCoverage = { symbol: string; qty: number };

export function indiaGttCoverage(holding: IndiaHoldingForCoverage, triggers: KiteGttForCoverage[]) {
  const bareSymbol = holding.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const sameSymbol = triggers.filter((trigger) => String(trigger.condition?.tradingsymbol ?? "").toUpperCase() === bareSymbol);
  const expiredOrInvalid = sameSymbol.filter((trigger) => {
    if (trigger.status !== "active" || !trigger.expires_at) return false;
    const expiry = Date.parse(trigger.expires_at);
    return !Number.isFinite(expiry) || expiry <= Date.now();
  });
  if (expiredOrInvalid.length) return { state: "review" as const, reason: "Kite reports an active GTT with expired or invalid expiry; reconcile its broker status." };
  const matches = sameSymbol.filter((trigger) => trigger.status === "active");
  if (matches.length === 0) return { state: "unprotected" as const, reason: "No active Kite GTT for this holding." };
  if (matches.length > 1) return { state: "review" as const, reason: `${matches.length} active GTTs match; reconcile to avoid overlapping sell orders.` };

  const trigger = matches[0];
  const sellOrders = (trigger.orders ?? []).filter((order) => String(order.transaction_type).toUpperCase() === "SELL");
  if (sellOrders.length === 0) return { state: "unprotected" as const, reason: "The active GTT has no SELL child order." };
  if (sellOrders.some((order) => String(order.order_type).toUpperCase() !== "LIMIT")) {
    return { state: "review" as const, reason: "The GTT has an unsupported or unknown SELL child order type." };
  }
  const quantities = [...new Set(sellOrders.map((order) => Number(order.quantity)).filter(Number.isFinite))];
  if (quantities.length !== 1 || quantities[0] <= 0) return { state: "review" as const, reason: "GTT sell-leg quantities are missing or disagree." };

  const protectedQty = quantities[0];
  const state = protectedQty === holding.qty ? "covered" as const : protectedQty < holding.qty ? "partial" as const : "overcovered" as const;
  const triggerValues = trigger.condition?.trigger_values ?? [];
  const sellPrices = sellOrders.map((order) => Number(order.price)).filter((price) => Number.isFinite(price) && price > 0);
  return {
    state,
    triggerId: String(trigger.id),
    expiresAt: trigger.expires_at ?? null,
    protectedQty,
    stopPrice: triggerValues.length ? Number(triggerValues[0]) : sellPrices[0] ?? null,
    targetPrice: triggerValues.length > 1 ? Number(triggerValues[1]) : null,
    reason: state === "covered" ? "One active GTT's SELL legs match the full Kite holding." : `GTT quantity ${protectedQty} does not match holding quantity ${holding.qty}.`,
  };
}
