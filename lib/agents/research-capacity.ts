export type ResearchMarket = "us" | "india";

export const DEFAULT_RESEARCH_CANDIDATE_CAP: Record<ResearchMarket, number> = {
  us: 40,
  india: 10,
};

/** Parse the shared per-market candidate ceiling without allowing invalid or
 * non-positive environment values to silently disable candidate research. */
export function researchCandidateCap(
  market: ResearchMarket,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): number {
  const key = market === "india" ? "RESEARCH_INDIA_CANDIDATE_CAP" : "RESEARCH_CANDIDATE_CAP";
  const raw = env[key];
  if (raw == null || raw.trim() === "") return DEFAULT_RESEARCH_CANDIDATE_CAP[market];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESEARCH_CANDIDATE_CAP[market];
}

/** Newly listed names are a separate evidence-only lane; keep it explicitly
 * bounded even when an environment value is misconfigured. */
export function newListingObservationCap(env: Partial<NodeJS.ProcessEnv> = process.env): number {
  const raw = env.RESEARCH_NEW_LISTING_OBSERVATIONS_PER_RUN;
  if (raw == null || raw.trim() === "") return 4;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(4, parsed)) : 4;
}
