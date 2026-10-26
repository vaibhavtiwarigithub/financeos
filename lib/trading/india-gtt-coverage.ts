export type KiteGttForCoverage = {
  id: number | string;
  status: string;
  expires_at?: string | null;
  condition?: { tradingsymbol?: string; exchange?: string; trigger_values?: number[] };
  orders?: Array<{ transaction_type?: string; quantity?: number; order_type?: string; price?: number; exchange?: string; tradingsymbol?: string }>;
};

export type IndiaHoldingForCoverage = { symbol: string; qty: number; currentPrice?: number | null };

export function indiaGttCoverage(holding: IndiaHoldingForCoverage, triggers: KiteGttForCoverage[]) {
  const bareSymbol = holding.symbol.replace(/\.(NS|BO)$/i, "").toUpperCase();
  const exchange = /\.NS$/i.test(holding.symbol) ? "NSE" : /\.BO$/i.test(holding.symbol) ? "BSE" : null;
  if (!exchange) return { state: "unknown" as const, reason: "The holding exchange is unavailable." };
  const sameName = triggers.filter(trigger => String(trigger.condition?.tradingsymbol ?? "").toUpperCase() === bareSymbol);
  if (sameName.some(trigger => trigger.status === "active" && !trigger.condition?.exchange)) {
    return { state: "review" as const, reason: "An active same-symbol GTT has no verified exchange." };
  }
  const sameSymbol = sameName.filter(trigger => String(trigger.condition?.exchange).toUpperCase() === exchange);
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
  if (!Array.isArray(trigger.orders) || trigger.orders.some(order => !order || typeof order !== "object")) {
    return { state: "review" as const, reason: "GTT child orders are malformed." };
  }
  const sellOrders = (trigger.orders ?? []).filter((order) => String(order.transaction_type).toUpperCase() === "SELL");
  if (sellOrders.length === 0) return { state: "unprotected" as const, reason: "The active GTT has no SELL child order." };
  if (sellOrders.some(order => (order.exchange && order.exchange.toUpperCase() !== exchange)
    || (order.tradingsymbol && order.tradingsymbol.toUpperCase() !== bareSymbol))) {
    return { state: "review" as const, reason: "GTT child order identity disagrees with its holding or exchange." };
  }
  if (sellOrders.some((order) => String(order.order_type).toUpperCase() !== "LIMIT")) {
    return { state: "review" as const, reason: "The GTT has an unsupported or unknown SELL child order type." };
  }
  if (sellOrders.some(order => order.quantity == null || !Number.isFinite(Number(order.quantity)) || Number(order.quantity) <= 0
    || order.price == null || !Number.isFinite(Number(order.price)) || Number(order.price) <= 0)) {
    return { state: "review" as const, reason: "GTT sell-leg quantity or limit price is missing or invalid." };
  }
  const quantities = [...new Set(sellOrders.map((order) => Number(order.quantity)))];
  if (quantities.length !== 1 || quantities[0] <= 0) return { state: "review" as const, reason: "GTT sell-leg quantities are missing or disagree." };

  const triggerValues = trigger.condition?.trigger_values ?? [];
  if (!Array.isArray(triggerValues) || triggerValues.length !== trigger.orders.length || triggerValues.length < 1 || triggerValues.length > 2
    || triggerValues.some(value => value == null || !Number.isFinite(Number(value)) || Number(value) <= 0)) {
    return { state: "review" as const, reason: "GTT trigger prices are missing, invalid, or not aligned with child orders." };
  }
  if (holding.currentPrice == null || !Number.isFinite(holding.currentPrice) || holding.currentPrice <= 0) {
    return { state: "unknown" as const, reason: "A current holding price is required to distinguish a downside stop from a target-only GTT." };
  }
  // Kite maps trigger and child by array index. A BUY leg or an above-market
  // profit target is not downside SELL protection for the held long position.
  const sellLevels = triggerValues.flatMap((value, index) =>
    String(trigger.orders![index].transaction_type).toUpperCase() === "SELL" ? [Number(value)] : []);
  const stopLevels = sellLevels.filter(value => value < holding.currentPrice!);
  if (stopLevels.length !== 1) return { state: "review" as const, reason: "The active GTT does not have exactly one verified downside SELL trigger; reconcile its stop coverage." };
  const protectedQty = quantities[0];
  const state = protectedQty === holding.qty ? "covered" as const : protectedQty < holding.qty ? "partial" as const : "overcovered" as const;
  return {
    state,
    triggerId: String(trigger.id),
    expiresAt: trigger.expires_at ?? null,
    protectedQty,
    stopPrice: stopLevels[0],
    targetPrice: sellLevels.find(value => value > holding.currentPrice!) ?? null,
    reason: state === "covered" ? "One active GTT's SELL legs match the full Kite holding." : `GTT quantity ${protectedQty} does not match holding quantity ${holding.qty}.`,
  };
}
