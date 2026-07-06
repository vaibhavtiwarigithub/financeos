// Pure math for the goal tracker (Part C). Never wired into any agent —
// return targets are a measured dashboard, not an agent parameter (Decision 34).

export function requiredDailyPct(targetPct: number, horizonDays: number): number {
  if (horizonDays <= 0) return 0;
  return (Math.pow(1 + targetPct / 100, 1 / horizonDays) - 1) * 100;
}

export function feasibilityNote(required: number, realized: number): string {
  if (!Number.isFinite(realized)) return "Not enough trading history yet to compare against.";
  if (required <= 0) return "Target already at or below the starting NAV.";
  if (realized <= 0) {
    return `Requires ${required.toFixed(2)}%/day; realized edge is flat or negative — far above demonstrated edge.`;
  }
  const ratio = required / realized;
  if (ratio <= 1) return `Requires ${required.toFixed(2)}%/day; realized edge ${realized.toFixed(2)}%/day — within demonstrated range.`;
  if (ratio <= 2) return `Requires ${required.toFixed(2)}%/day; realized edge ${realized.toFixed(2)}%/day — somewhat above demonstrated edge.`;
  return `Requires ${required.toFixed(2)}%/day; realized edge last 90d: ${realized.toFixed(2)}%/day — far above demonstrated edge.`;
}

export function computeGoalFeasibility(args: { targetPct: number; horizonDays: number; realizedDailyPct: number }) {
  const required = requiredDailyPct(args.targetPct, args.horizonDays);
  return { requiredDailyPct: required, feasibility: feasibilityNote(required, args.realizedDailyPct) };
}
