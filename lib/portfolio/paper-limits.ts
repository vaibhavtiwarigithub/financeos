import { DEFAULT_LIMITS } from "@/lib/portfolio/constructor";

type LimitSource = Record<string, unknown> | null | undefined;

function boundedLimit(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback;
}

/** Resolve paper-only exposure ceilings without widening a staged deployment. */
export function resolvePaperExposureLimits(input: {
  shared?: LimitSource;
  paper?: LimitSource;
  paperConfigAvailable: boolean;
}) {
  const { shared, paper, paperConfigAvailable } = input;
  return {
    maxSectorExposurePct: paperConfigAvailable
      ? boundedLimit(paper?.max_sector_exposure_pct_paper, DEFAULT_LIMITS.maxSectorExposurePct)
      : boundedLimit(shared?.max_sector_exposure_pct, DEFAULT_LIMITS.maxSectorExposurePct),
    maxNameExposurePct: paperConfigAvailable
      ? boundedLimit(paper?.max_name_exposure_pct_paper, DEFAULT_LIMITS.maxNameExposurePct)
      : boundedLimit(shared?.max_name_exposure_pct, DEFAULT_LIMITS.maxNameExposurePct),
  };
}
