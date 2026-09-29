/**
 * Decision-time price provenance for measure-only shadow rows.
 *
 * This is the observed research price, not a fill or executable quote. A future
 * replay must apply its own declared execution and price convention.
 */
export function shadowDecisionEntryEvidence(value: unknown): { entry_price: number | null } {
  if (value == null || value === "") return { entry_price: null };
  const price = typeof value === "number" ? value : Number(value);
  return { entry_price: Number.isFinite(price) && price > 0 ? price : null };
}
