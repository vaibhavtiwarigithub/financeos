export interface EarningsHoldingTarget {
  environment: "paper" | "live";
  symbol: string;
  spot: number;
  stopDistancePct: number | null;
  horizonSessions: number;
}

function positive(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function boundedHorizon(value: unknown, fallback: number): number {
  const parsed = positive(value);
  return Math.max(1, Math.min(20, Math.round(parsed ?? fallback)));
}

/**
 * Deduplicate holdings without cross-environment or cross-account aggregation.
 * A symbol held in paper and live remains two separately-audited observations.
 */
export function buildEarningsHoldingTargets(input: {
  paperPositions: any[];
  liveSnapshots: any[];
  defaultHorizonSessions: number;
  maxPerEnvironment?: number;
}): EarningsHoldingTarget[] {
  const max = Math.max(1, Math.min(50, input.maxPerEnvironment ?? 30));
  const output: EarningsHoldingTarget[] = [];

  const paperSeen = new Set<string>();
  for (const position of input.paperPositions) {
    const symbol = String(position?.symbol ?? "").trim().toUpperCase();
    const spot = positive(position?.current_price);
    if (!symbol || spot == null || paperSeen.has(symbol) || paperSeen.size >= max) continue;
    paperSeen.add(symbol);
    const stop = positive(position?.stop_loss);
    output.push({
      environment: "paper",
      symbol,
      spot,
      // A stop at/above spot is stale or malformed, not a meaningful distance.
      stopDistancePct: stop == null || stop >= spot ? null : (spot - stop) / spot,
      horizonSessions: boundedHorizon(position?.resolved_horizon_days, input.defaultHorizonSessions),
    });
  }

  const liveSeen = new Set<string>();
  for (const holding of input.liveSnapshots) {
    const symbol = String(holding?.symbol ?? "").trim().toUpperCase();
    const spot = positive(holding?.current_price);
    if (!symbol || spot == null || liveSeen.has(symbol) || liveSeen.size >= max) continue;
    liveSeen.add(symbol);
    output.push({
      environment: "live",
      symbol,
      spot,
      stopDistancePct: null,
      horizonSessions: boundedHorizon(null, input.defaultHorizonSessions),
    });
  }
  return output;
}

export function filterTargetsForCachedEvents(
  targets: EarningsHoldingTarget[],
  eventDateBySymbol: Map<string, string>,
  sessionsUntil: (reportDate: string) => number | null,
): EarningsHoldingTarget[] {
  return targets.filter(target => {
    const reportDate = eventDateBySymbol.get(target.symbol);
    if (!reportDate) return false;
    const sessions = sessionsUntil(reportDate);
    return sessions != null && sessions >= 0 && sessions <= target.horizonSessions;
  });
}
