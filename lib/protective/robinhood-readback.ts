// A placement/cancel acknowledgement is not proof of a resting/canceled stop.
// Unknown or incomplete broker order details always remain unreconciled.
export function verifyRobinhoodRestingStop(raw: unknown, expected: {
  symbol: string; account: string; qty: number; stopPrice: number;
}): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  const type = String(o.type ?? o.order_type ?? "").toLowerCase();
  const side = String(o.side ?? "").toLowerCase();
  const symbol = String(o.symbol ?? "").toUpperCase();
  const account = String(o.account_number ?? o.account ?? "");
  const tif = String(o.time_in_force ?? o.timeInForce ?? "").toLowerCase();
  const qty = Number(o.quantity ?? o.qty);
  const trigger = Number(o.stop_price ?? o.stopPrice ?? o.trigger_price);
  return (type === "stop" || type === "stop_market") && side === "sell"
    && symbol === expected.symbol.toUpperCase() && account === expected.account
    && tif === "gtc" && Number.isFinite(qty) && Math.abs(qty - expected.qty) < 1e-9
    && Number.isFinite(trigger) && Math.abs(trigger - expected.stopPrice) < 0.005;
}

export function robinhoodCancelIsFinal(status: string | undefined, filledQty: number | undefined): boolean {
  return status === "canceled" && filledQty != null && Number.isFinite(filledQty) && filledQty === 0;
}
