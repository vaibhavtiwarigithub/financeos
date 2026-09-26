export type AllocationReplayBar = { date: string; close: number };

export type AllocationReplayMetrics = {
  totalReturnPct: number;
  annualizedReturnPct: number;
  annualizedVolatilityPct: number;
  maxDrawdownPct: number;
};

export type InternationalAllocationReplay = {
  status: "completed" | "insufficient_history";
  reason?: string;
  minimumMatchedSessions: number;
  startDate: string | null;
  endDate: string | null;
  sessions: number;
  testWeightPct: number;
  rebalanceFrequency: "monthly";
  oneWayCostBps: number;
  rebalanceCount: number;
  turnoverPct: number;
  totalCostDragPct: number;
  baseline: AllocationReplayMetrics | null;
  testSleeve: AllocationReplayMetrics | null;
  baselineGross: AllocationReplayMetrics | null;
  testSleeveGross: AllocationReplayMetrics | null;
  excessReturnPct: number | null;
  informationRatio: number | null;
  independentBlocks: number;
  blockMeanExcessPct: number | null;
  blockCiLowerPct: number | null;
  blockCiUpperPct: number | null;
  blockTStatistic: number | null;
  windows: Array<{ startDate: string; endDate: string; baselineReturnPct: number; testSleeveReturnPct: number }>;
  caveats: string[];
};

const SESSIONS_PER_YEAR = 252;
export const MIN_MATCHED_SESSIONS = SESSIONS_PER_YEAR * 3;
export const ATTRIBUTION_BLOCK_SESSIONS = 63;

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function maxDrawdown(nav: number[]): number {
  let peak = nav[0] ?? 1;
  let maximum = 0;
  for (const value of nav) {
    peak = Math.max(peak, value);
    maximum = Math.max(maximum, peak === 0 ? 0 : (peak - value) / peak);
  }
  return maximum;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function studentTCritical95(df: number): number {
  const table = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093,
    2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  if (df <= 0) return Number.POSITIVE_INFINITY;
  if (df < table.length) return table[df];
  const z = 1.96;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2);
}

function blockStatistics(baselineDaily: number[], variantDaily: number[]) {
  const count = Math.floor(Math.min(baselineDaily.length, variantDaily.length) / ATTRIBUTION_BLOCK_SESSIONS);
  const differences: number[] = [];
  for (let block = 0; block < count; block++) {
    const from = block * ATTRIBUTION_BLOCK_SESSIONS;
    const to = from + ATTRIBUTION_BLOCK_SESSIONS;
    const baseline = baselineDaily.slice(from, to).reduce((nav, value) => nav * (1 + value), 1);
    const variant = variantDaily.slice(from, to).reduce((nav, value) => nav * (1 + value), 1);
    differences.push((variant - baseline) * 100);
  }
  if (differences.length < 2) return { count: differences.length, mean: null, lower: null, upper: null, t: null };
  const mean = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const sd = standardDeviation(differences);
  const se = sd / Math.sqrt(differences.length);
  if (se === 0) return { count: differences.length, mean: round(mean), lower: round(mean), upper: round(mean), t: null };
  const critical = studentTCritical95(differences.length - 1);
  return {
    count: differences.length,
    mean: round(mean),
    lower: round(mean - critical * se),
    upper: round(mean + critical * se),
    t: round(mean / se),
  };
}

function metrics(nav: number[], dailyReturns: number[]): AllocationReplayMetrics {
  const sessions = dailyReturns.length;
  const end = nav[nav.length - 1] ?? 1;
  return {
    totalReturnPct: round((end - 1) * 100),
    annualizedReturnPct: round(((end ** (SESSIONS_PER_YEAR / Math.max(sessions, 1))) - 1) * 100),
    annualizedVolatilityPct: round(standardDeviation(dailyReturns) * Math.sqrt(SESSIONS_PER_YEAR) * 100),
    maxDrawdownPct: round(maxDrawdown(nav) * 100),
  };
}

function isNewMonth(previous: string, current: string): boolean {
  return previous.slice(0, 7) !== current.slice(0, 7);
}

function alignedBars(voo: AllocationReplayBar[], vxus: AllocationReplayBar[]) {
  const validVxus = new Map(vxus.filter((bar) => Number.isFinite(bar.close) && bar.close > 0).map((bar) => [bar.date, bar.close]));
  return voo
    .filter((bar) => Number.isFinite(bar.close) && bar.close > 0 && validVxus.has(bar.date))
    .map((bar) => ({ date: bar.date, voo: bar.close, vxus: validVxus.get(bar.date)! }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// A fixed, fully specified historical diagnostic. This deliberately does not
// optimize weights or select a winner: it measures one predeclared broad-ex-US
// sleeve against VOO, using only same-session cached adjusted closes.
export function runInternationalAllocationReplay(
  voo: AllocationReplayBar[],
  vxus: AllocationReplayBar[],
  { testWeightPct = 20, oneWayCostBps = 5 }: { testWeightPct?: number; oneWayCostBps?: number } = {},
): InternationalAllocationReplay {
  if (!Number.isFinite(testWeightPct) || testWeightPct <= 0 || testWeightPct >= 100) {
    throw new Error("testWeightPct must be between 0 and 100");
  }
  if (!Number.isFinite(oneWayCostBps) || oneWayCostBps < 0) throw new Error("oneWayCostBps must be non-negative");

  const bars = alignedBars(voo, vxus);
  const base = {
    minimumMatchedSessions: MIN_MATCHED_SESSIONS,
    startDate: bars[0]?.date ?? null,
    endDate: bars.at(-1)?.date ?? null,
    sessions: bars.length,
    testWeightPct,
    rebalanceFrequency: "monthly" as const,
    oneWayCostBps,
    rebalanceCount: 0,
    turnoverPct: 0,
    totalCostDragPct: 0,
    baseline: null,
    testSleeve: null,
    baselineGross: null,
    testSleeveGross: null,
    excessReturnPct: null,
    informationRatio: null,
    independentBlocks: 0,
    blockMeanExcessPct: null,
    blockCiLowerPct: null,
    blockCiUpperPct: null,
    blockTStatistic: null,
    windows: [],
    caveats: [
      "Cache-only adjusted-close replay; it does not reconstruct Kairos paper or live holdings.",
      "Monthly scheduled rebalances apply a fixed one-way transaction-cost assumption; taxes, bid-ask spreads, and withholding are not modeled.",
      "The fixed 20% sleeve is a diagnostic test configuration, not an owner target, recommendation, or executable allocation.",
    ],
  };
  if (bars.length < MIN_MATCHED_SESSIONS) {
    return {
      status: "insufficient_history",
      reason: `Needs ${MIN_MATCHED_SESSIONS} matched VOO/VXUS sessions; cache currently has ${bars.length}.`,
      ...base,
    };
  }

  // The two US-listed ETFs share a session calendar. Ignore trailing VOO rows
  // after the last VXUS close (the as-of date is the latest common session),
  // but never bridge an interior missing leg and call it a daily return.
  const commonEnd = bars.at(-1)!.date;
  const vooSessions = voo.filter((bar) => bar.date <= commonEnd && Number.isFinite(bar.close) && bar.close > 0).map((bar) => bar.date).sort();
  const vxusSessions = vxus.filter((bar) => bar.date <= commonEnd && Number.isFinite(bar.close) && bar.close > 0).map((bar) => bar.date).sort();
  if (vooSessions.length !== vxusSessions.length || vooSessions.some((date, index) => date !== vxusSessions[index])) {
    return {
      status: "insufficient_history",
      reason: "The matched price cache has an interior missing VOO/VXUS session; replay refuses to bridge the gap.",
      ...base,
    };
  }

  const targetVxusWeight = testWeightPct / 100;
  const costRate = oneWayCostBps / 10_000;
  let baselineNav = 1;
  let vooUnits = (1 - targetVxusWeight) / bars[0].voo;
  let vxusUnits = targetVxusWeight / bars[0].vxus;
  let grossVooUnits = vooUnits;
  let grossVxusUnits = vxusUnits;
  let grossNav = 1;
  let sleeveNav = 1;
  let rebalanceCount = 0;
  let turnoverNotional = 0;
  const baselineNavs = [baselineNav];
  const sleeveNavs = [sleeveNav];
  const grossSleeveNavs = [grossNav];
  const baselineReturns: number[] = [];
  const sleeveReturns: number[] = [];
  const grossSleeveReturns: number[] = [];

  for (let index = 1; index < bars.length; index++) {
    const previous = bars[index - 1];
    const current = bars[index];
    const baselineReturn = current.voo / previous.voo - 1;
    baselineNav *= 1 + baselineReturn;

    const beforeCost = vooUnits * current.voo + vxusUnits * current.vxus;
    const grossBeforeRebalance = grossVooUnits * current.voo + grossVxusUnits * current.vxus;
    let afterCost = beforeCost;
    if (isNewMonth(previous.date, current.date)) {
      const currentVxusValue = vxusUnits * current.vxus;
      // For a two-asset fully invested sleeve, this is the one-way notional that
      // changes hands. The matching VOO sale/buy is the funding leg, not double-counted.
      const tradedNotional = Math.abs(currentVxusValue - beforeCost * targetVxusWeight);
      turnoverNotional += tradedNotional;
      const cost = tradedNotional * costRate;
      afterCost -= cost;
      vooUnits = (afterCost * (1 - targetVxusWeight)) / current.voo;
      vxusUnits = (afterCost * targetVxusWeight) / current.vxus;
      grossVooUnits = (grossBeforeRebalance * (1 - targetVxusWeight)) / current.voo;
      grossVxusUnits = (grossBeforeRebalance * targetVxusWeight) / current.vxus;
      rebalanceCount++;
    }
    grossNav = grossVooUnits * current.voo + grossVxusUnits * current.vxus;
    sleeveNav = afterCost;
    baselineNavs.push(baselineNav);
    sleeveNavs.push(sleeveNav);
    baselineReturns.push(baselineReturn);
    sleeveReturns.push(sleeveNavs.at(-1)! / sleeveNavs.at(-2)! - 1);
    grossSleeveNavs.push(grossNav);
    grossSleeveReturns.push(grossSleeveNavs.at(-1)! / grossSleeveNavs.at(-2)! - 1);
  }

  const excessDaily = sleeveReturns.map((value, index) => value - baselineReturns[index]);
  const excessMean = excessDaily.reduce((sum, value) => sum + value, 0) / excessDaily.length;
  const trackingError = standardDeviation(excessDaily);
  const informationRatio = trackingError === 0 ? null : round((excessMean / trackingError) * Math.sqrt(SESSIONS_PER_YEAR));
  const baselineMetrics = metrics(baselineNavs, baselineReturns);
  const sleeveMetrics = metrics(sleeveNavs, sleeveReturns);
  const baselineGrossMetrics = metrics(baselineNavs, baselineReturns);
  const sleeveGrossMetrics = metrics(grossSleeveNavs, grossSleeveReturns);
  const blocks = blockStatistics(baselineReturns, sleeveReturns);
  const windowSize = Math.floor((bars.length - 1) / 3);
  const windows = [0, 1, 2].map((window) => {
    const start = window * windowSize;
    const end = window === 2 ? bars.length - 1 : (window + 1) * windowSize;
    const baseReturn = baselineNavs[end] / baselineNavs[start] - 1;
    const sleeveReturn = sleeveNavs[end] / sleeveNavs[start] - 1;
    return { startDate: bars[start].date, endDate: bars[end].date, baselineReturnPct: round(baseReturn * 100), testSleeveReturnPct: round(sleeveReturn * 100) };
  });

  return {
    status: "completed",
    ...base,
    rebalanceCount,
    turnoverPct: round(turnoverNotional * 100),
    totalCostDragPct: round((grossNav - sleeveNav) * 100),
    baseline: baselineMetrics,
    testSleeve: sleeveMetrics,
    baselineGross: baselineGrossMetrics,
    testSleeveGross: sleeveGrossMetrics,
    excessReturnPct: round(sleeveMetrics.totalReturnPct - baselineMetrics.totalReturnPct),
    informationRatio,
    independentBlocks: blocks.count,
    blockMeanExcessPct: blocks.mean,
    blockCiLowerPct: blocks.lower,
    blockCiUpperPct: blocks.upper,
    blockTStatistic: blocks.t,
    windows,
  };
}
