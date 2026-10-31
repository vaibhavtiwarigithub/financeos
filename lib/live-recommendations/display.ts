/** Counterfactual value difference for the suggested reduction quantity, versus continuing to hold it. */
export function hypotheticalReductionImpact(qty: number | null, signalPrice: number | null, lastPrice: number | null): number | null {
  if (qty == null || !Number.isFinite(qty) || qty <= 0 || signalPrice == null || !Number.isFinite(signalPrice) || signalPrice <= 0 || lastPrice == null || !Number.isFinite(lastPrice) || lastPrice <= 0) return null;
  return Math.round(qty * (signalPrice - lastPrice) * 100) / 100;
}
