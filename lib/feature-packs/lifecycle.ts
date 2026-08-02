// Feature discovery lifecycle is intentionally narrower than strategy promotion.
// A registry formula can collect evidence, but it never becomes a scoring input
// merely because a small IC check passed.

export type FeatureRegistryStatus = "proposed" | "quarantined" | "measure_only" | "retired";

export function nextFeatureRegistryStatus(
  current: FeatureRegistryStatus,
  promotionEvidencePassed: boolean,
  shouldRetire: boolean,
): FeatureRegistryStatus {
  if (shouldRetire && current === "measure_only") return "retired";
  if (!promotionEvidencePassed) return current;
  if (current === "proposed") return "quarantined";
  if (current === "quarantined") return "measure_only";
  return current;
}

export function featureRegistryTransitionReason(
  from: FeatureRegistryStatus,
  to: FeatureRegistryStatus,
  foldCount: number,
): string {
  if (to === "retired") return "rolling IC decayed below retirement threshold";
  if (to === "quarantined") return `initial IC screen passed (${foldCount} folds); awaiting repeated measure-only evidence`;
  if (to === "measure_only") return `repeat IC screen passed (${foldCount} folds); observation only, not score-eligible`;
  return "no lifecycle change";
}
