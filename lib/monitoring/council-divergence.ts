// LLM council vs deterministic composite: where the council materially disagrees with the score the paper trader actually uses.
//
// Two calibration facts from production (36 h of completed runs, 2026-10-13) shape the rule:
//   * The council is NOT unbiased against the composite: India's council median sat 12.6 points BELOW the deterministic composite on
//     average (the composite renormalizes onto fundamental + technical only), US only 3.7 below. A flat 20-point rule would flag
//     ~24% of India symbols, so the gap is measured AFTER removing the market's own typical offset (median signed gap).
//   * Most symbols never matter to a trade, so only symbols that are HELD or are ENTRY-ELIGIBLE longs (deterministic long at or near the
//     threshold) can raise the alert. Everything else stays visible in the tables, not in alerts.
// Member disagreement (max - min across DeepSeek/Claude/Codex) is reported for the same relevant symbols.

export type DivergenceRun = {
  market: "us" | "india";
  symbol: string;
  decision_ts: string;
  consensus: number | null;
  deterministic: number | null;
  threshold: number | null;
  direction: string | null;
  memberSpread: number | null;
};

export type DivergenceHit = {
  market: "us" | "india";
  symbol: string;
  decisionTs: string;
  council: number;
  deterministic: number;
  rawGap: number;
  adjustedGap: number;
  memberSpread: number | null;
  reasons: string[];
  held: boolean;
  entryEligible: boolean;
};

export const COUNCIL_DIVERGENCE_MIN_ADJUSTED_GAP = 20;
export const COUNCIL_MEMBER_SPREAD_MIN = 25;
export const COUNCIL_BIAS_MIN_SAMPLE = 30;
export const ENTRY_NEAR_THRESHOLD_POINTS = 5;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Median signed gap (council − deterministic) per market; 0 until there is enough sample to trust it. */
export function councilBiasByMarket(runs: DivergenceRun[], minSample = COUNCIL_BIAS_MIN_SAMPLE): Record<"us" | "india", number> {
  const out = { us: 0, india: 0 };
  for (const market of ["us", "india"] as const) {
    const gaps = runs.filter((r) => r.market === market && r.consensus != null && r.deterministic != null).map((r) => r.consensus! - r.deterministic!);
    out[market] = gaps.length >= minSample ? (median(gaps) ?? 0) : 0;
  }
  return out;
}

export function findCouncilDivergence(args: {
  /** Recent completed runs (for the bias estimate); the newest run per symbol inside `alertWindowStart` is evaluated. */
  runs: DivergenceRun[];
  alertWindowStart: string;
  held: Set<string>; // `${market}:${symbol}`
  minAdjustedGap?: number;
  minMemberSpread?: number;
}): { hits: DivergenceHit[]; bias: Record<"us" | "india", number> } {
  const minGap = args.minAdjustedGap ?? COUNCIL_DIVERGENCE_MIN_ADJUSTED_GAP;
  const minSpread = args.minMemberSpread ?? COUNCIL_MEMBER_SPREAD_MIN;
  const bias = councilBiasByMarket(args.runs);

  const newest = new Map<string, DivergenceRun>();
  for (const run of args.runs) {
    if (run.decision_ts < args.alertWindowStart) continue;
    const key = `${run.market}:${run.symbol}`;
    const cur = newest.get(key);
    if (!cur || run.decision_ts > cur.decision_ts) newest.set(key, run);
  }

  const hits: DivergenceHit[] = [];
  for (const [key, run] of newest) {
    if (run.consensus == null || run.deterministic == null) continue;
    const held = args.held.has(key);
    const entryEligible = run.direction === "long" && run.threshold != null && run.deterministic >= run.threshold - ENTRY_NEAR_THRESHOLD_POINTS;
    if (!held && !entryEligible) continue;
    const rawGap = run.consensus - run.deterministic;
    const adjustedGap = rawGap - bias[run.market];
    const reasons: string[] = [];
    if (Math.abs(adjustedGap) >= minGap) {
      reasons.push(adjustedGap < 0
        ? `council ${Math.round(run.consensus)} is ${Math.abs(Math.round(adjustedGap))} points below the deterministic ${Math.round(run.deterministic)} (after the ${run.market.toUpperCase()} offset of ${bias[run.market].toFixed(0)})`
        : `council ${Math.round(run.consensus)} is ${Math.round(adjustedGap)} points above the deterministic ${Math.round(run.deterministic)} (after the ${run.market.toUpperCase()} offset of ${bias[run.market].toFixed(0)})`);
    }
    if (run.memberSpread != null && run.memberSpread >= minSpread) reasons.push(`the three members disagree by ${Math.round(run.memberSpread)} points`);
    if (!reasons.length) continue;
    hits.push({ market: run.market, symbol: run.symbol, decisionTs: run.decision_ts, council: run.consensus, deterministic: run.deterministic, rawGap, adjustedGap, memberSpread: run.memberSpread, reasons, held, entryEligible });
  }
  return { hits: hits.sort((a, b) => Math.abs(b.adjustedGap) - Math.abs(a.adjustedGap) || (b.memberSpread ?? 0) - (a.memberSpread ?? 0)), bias };
}
