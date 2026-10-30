import { MODELED_SLIP_FRACTION } from "@/lib/analytics/performance-metrics";
import { simulatePortfolio } from "@/lib/simulation/portfolio-simulator";
import type { Bar } from "./compile";
import { compileSpec } from "./compile";
import { markNavSeries, type DailyMark, type HoldingsAt } from "./nav-marker";
import type { RuleSpec } from "./rule-spec";

export interface TemplateBacktestResult {
  status: "insufficient_data" | "diagnostic_only";
  method: "fixed-rule-70-30-temporal-holdout-v1";
  market: "us" | "india";
  benchmark: string;
  dataFrom: string | null;
  dataThrough: string | null;
  symbols: number;
  bars: number;
  priceSources: string[];
  priceBases: string[];
  provenanceVersions: string[];
  warmup: number;
  inSample: ReplayMetrics | null;
  holdout: ReplayMetrics | null;
  limitation: string;
}

export interface ReplayMetrics {
  sessions: number;
  decisions: number;
  trades: number;
  fills: number;
  rejections: number;
  rejectedEventRate: number;
  returnPct: number | null;
  benchmarkReturnPct: number | null;
  excessReturnPp: number | null;
  maxDrawdownPct: number;
  sharpe: number | null;
  sortino: number | null;
  unpricedSessions: number;
  benchmarkMissingSessions: number;
  scenarios: Array<{
    classifier: "benchmark_trend_50sma" | "benchmark_volatility_20d_training_tercile";
    regime: string;
    sessions: number;
    meanStrategyDailyReturnPct: number;
    meanBenchmarkDailyReturnPct: number;
    meanExcessDailyReturnPp: number;
    strategyCumulativeReturnPct: number;
    benchmarkCumulativeReturnPct: number;
    excessReturnPp: number;
  }>;
}

export interface TemplateBacktestInput {
  spec: RuleSpec;
  bars: Record<string, Bar[]>;
  benchmark: string;
  benchmarkBars: Record<string, Bar[]>;
  provenance: Array<{ provider: string; priceBasis: string; provenanceVersion: string }>;
  initialCash: number;
}

/**
 * Fixed-rule diagnostic, not a fitted or promotion-grade result. Indicators
 * warm up on the earlier 70%; orders execute only in the final temporal 30%.
 * Costs are applied by the same compiler/simulator used by strategy replay.
 */
export function runTemplateBacktest(input: TemplateBacktestInput): TemplateBacktestResult {
  const sessions = [...new Set(Object.values(input.bars).flat().map((b) => b.session))].sort();
  const totalBars = Object.values(input.bars).reduce((sum, series) => sum + series.length, 0);
  const benchmarkSeries = input.benchmarkBars[input.benchmark] ?? [];
  const benchmarkBySession = new Map(benchmarkSeries.map((bar) => [bar.session, bar.close]));
  const splitAt = Math.floor(sessions.length * 0.7);
  const enoughForSplit = sessions.length >= 30 && splitAt >= 2 && sessions.length - splitAt > input.spec.horizonSessions + 1;
  const warmup = requiredWarmup(input.spec.entry);

  const result: TemplateBacktestResult = {
    status: "insufficient_data",
    method: "fixed-rule-70-30-temporal-holdout-v1",
    market: input.spec.market,
    benchmark: input.benchmark,
    dataFrom: sessions[0] ?? null,
    dataThrough: sessions[sessions.length - 1] ?? null,
    symbols: Object.keys(input.bars).length,
    bars: totalBars,
    priceSources: [...new Set(input.provenance.map((p) => p.provider))].sort(),
    priceBases: [...new Set(input.provenance.map((p) => p.priceBasis))].sort(),
    provenanceVersions: [...new Set(input.provenance.map((p) => p.provenanceVersion))].sort(),
    warmup,
    inSample: null,
    holdout: null,
    limitation: "Not enough aligned sessions for a temporal holdout with the rule's warm-up and exit horizon.",
  };
  if (!enoughForSplit || !benchmarkBySession.size || Object.keys(input.bars).length === 0) return result;

  const splitSession = sessions[splitAt];
  const lastSession = sessions[sessions.length - 1];
  const trainEnd = sessions[splitAt - 1];
  const train = replay(input, sessions[0], trainEnd, sessions, sessions[0], trainEnd);
  // Include the final training-session signal in the test replay because its
  // next-open fill occurs on the first holdout session. Its decision is not
  // included in the holdout decision count.
  const test = replay(input, splitSession, lastSession, sessions, trainEnd, trainEnd);
  result.inSample = train;
  result.holdout = test;
  result.status = "diagnostic_only";
  result.limitation = "Fixed-rule temporal holdout is descriptive only: current research cache is survivorship-selected, template trials are multiple-tested, and no promotion gate is satisfied by this result.";
  return result;
}

function replay(input: TemplateBacktestInput, start: string, end: string, allSessions: string[], signalStart: string, trainingThrough: string): ReplayMetrics {
  // Compile each constituent as an equal-weight sleeve. The compiler's cash
  // ledger is intentionally single-symbol; applying it to an entire universe
  // in symbol order would allocate capital by alphabetical symbol history.
  // Independent equal-weight sleeves remove that ordering artifact and make
  // the portfolio construction reproducible across runs.
  const symbols = input.spec.universe.filter((symbol) => input.bars[symbol]?.length);
  const sleeveCash = symbols.length ? input.initialCash / symbols.length : input.initialCash;
  const perSymbol = symbols.map((symbol) => compileSpec({
    spec: { ...input.spec, universe: [symbol] },
    bars: { [symbol]: input.bars[symbol] },
    initialCash: sleeveCash,
    fromSession: signalStart,
    throughSession: end,
  }));
  const compiled = {
    events: perSymbol.flatMap((result) => result.events),
    decisions: perSymbol.flatMap((result) => result.decisions),
    errors: perSymbol.flatMap((result) => result.errors),
  };
  const sim = simulatePortfolio({
    market: input.spec.market,
    currency: input.spec.market === "us" ? "USD" : "INR",
    initialCash: input.initialCash,
    maxOpenNames: Math.max(1, input.spec.universe.length),
    allowFractionalShares: true,
  }, compiled.events);
  const fillMap = new Map<string, typeof sim.fills>();
  for (const fill of sim.fills) fillMap.set(fill.session, [...(fillMap.get(fill.session) ?? []), fill]);
  let cash = input.initialCash;
  const held = new Map<string, { quantity: number; costBasis: number }>();
  const path: HoldingsAt[] = [];
  const marks: DailyMark[] = [];
  const testSessions = allSessions.filter((session) => session >= start && session <= end);
  const priorSession = allSessions.filter((session) => session < start).at(-1);
  if (priorSession) {
    const priorBenchmarkClose = input.benchmarkBars[input.benchmark]?.find((bar) => bar.session === priorSession)?.close ?? null;
    path.push({ session: priorSession, cash, positions: [] });
    marks.push({ session: priorSession, prices: {}, benchClose: priorBenchmarkClose });
  }
  for (const session of testSessions) {
    for (const fill of fillMap.get(session) ?? []) {
      const current = held.get(fill.symbol) ?? { quantity: 0, costBasis: 0 };
      if (fill.kind === "entry") {
        cash -= fill.gross + fill.cost;
        const nextQuantity = current.quantity + fill.quantity;
        current.costBasis = nextQuantity > 0 ? (current.costBasis * current.quantity + fill.gross + fill.cost) / nextQuantity : 0;
        current.quantity = nextQuantity;
        held.set(fill.symbol, current);
      } else {
        cash += fill.gross - fill.cost;
        current.quantity -= fill.quantity;
        if (current.quantity <= 1e-9) held.delete(fill.symbol); else held.set(fill.symbol, current);
      }
    }
    const prices: Record<string, number> = {};
    for (const [symbol, series] of Object.entries(input.bars)) {
      const bar = series.find((item) => item.session === session);
      if (bar) prices[symbol] = bar.close;
    }
    const benchmarkClose = input.benchmarkBars[input.benchmark]?.find((bar) => bar.session === session)?.close ?? null;
    path.push({ session, cash, positions: [...held.entries()].map(([symbol, pos]) => ({ symbol, quantity: pos.quantity, costBasis: pos.costBasis })) });
    marks.push({ session, prices, benchClose: benchmarkClose });
  }
  const nav = markNavSeries(path, marks);
  const benchmarkBySession = new Set((input.benchmarkBars[input.benchmark] ?? []).map((bar) => bar.session));
  const attempted = sim.fills.length + sim.rejections.length;
  const entries = sim.fills.filter((fill) => fill.kind === "entry").length;
  const enoughTrades = entries >= 30;
  return {
    sessions: testSessions.length,
    decisions: compiled.decisions.filter((decision) => decision.session >= start && decision.session <= end).length,
    trades: entries,
    fills: sim.fills.length,
    rejections: sim.rejections.length,
    rejectedEventRate: attempted ? sim.rejections.length / attempted : 0,
    returnPct: nav.totalReturnPct,
    benchmarkReturnPct: nav.benchTotalReturnPct,
    excessReturnPp: nav.netExcessReturnPp,
    maxDrawdownPct: nav.maxDrawdownPct,
    sharpe: enoughTrades ? nav.sharpe : null,
    sortino: enoughTrades ? nav.sortino : null,
    unpricedSessions: nav.unpricedSessions,
    benchmarkMissingSessions: testSessions.filter((session) => !benchmarkBySession.has(session)).length,
    scenarios: scenarioMetrics({
      navPoints: nav.points,
      benchmarkBars: input.benchmarkBars[input.benchmark] ?? [],
      start,
      end,
      trainingThrough,
    }),
  };
}

function scenarioMetrics(input: {
  navPoints: Array<{ session: string; nav: number; benchNav: number | null }>;
  benchmarkBars: Bar[];
  start: string;
  end: string;
  trainingThrough: string;
}): ReplayMetrics["scenarios"] {
  const closeBySession = new Map(input.benchmarkBars.map((bar) => [bar.session, bar.close]));
  const allBenchmark = [...input.benchmarkBars].sort((a, b) => a.session.localeCompare(b.session));
  const volBySession = new Map<string, number>();
  const returns: number[] = [];
  for (let i = 1; i < allBenchmark.length; i++) {
    const previous = allBenchmark[i - 1].close, current = allBenchmark[i].close;
    if (previous > 0 && current > 0) returns.push(current / previous - 1);
    const window = returns.slice(-20);
    if (window.length === 20) {
      const mean = window.reduce((sum, value) => sum + value, 0) / window.length;
      const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (window.length - 1);
      volBySession.set(allBenchmark[i].session, Math.sqrt(variance));
    }
  }
  const trainingVols = [...volBySession.entries()].filter(([session]) => session <= input.trainingThrough).map(([, value]) => value).sort((a, b) => a - b);
  const q33 = quantile(trainingVols, 1 / 3), q66 = quantile(trainingVols, 2 / 3);
  const grouped = new Map<string, Array<{ strategy: number; benchmark: number }>>();
  for (let i = 1; i < input.navPoints.length; i++) {
    const previous = input.navPoints[i - 1], current = input.navPoints[i];
    if (current.session < input.start || current.session > input.end || previous.nav <= 0 || previous.benchNav == null || current.benchNav == null || previous.benchNav <= 0) continue;
    const strategy = current.nav / previous.nav - 1;
    const benchmark = current.benchNav / previous.benchNav - 1;
    const priorClose = closeBySession.get(previous.session);
    const priorIndex = allBenchmark.findIndex((bar) => bar.session === previous.session);
    const priorSma = priorIndex >= 49 ? allBenchmark.slice(priorIndex - 49, priorIndex + 1).reduce((sum, bar) => sum + bar.close, 0) / 50 : null;
    const trend = priorClose != null && priorSma != null ? (priorClose > priorSma ? "above_sma50" : "at_or_below_sma50") : null;
    const priorVol = volBySession.get(previous.session);
    const volatility = priorVol == null || q33 == null || q66 == null ? null : priorVol <= q33 ? "low" : priorVol <= q66 ? "middle" : "high";
    for (const [classifier, regime] of [["benchmark_trend_50sma", trend], ["benchmark_volatility_20d_training_tercile", volatility]] as const) {
      if (regime == null) continue;
      const key = `${classifier}:${regime}`;
      grouped.set(key, [...(grouped.get(key) ?? []), { strategy, benchmark }]);
    }
  }
  return [...grouped.entries()].map(([key, rows]) => {
    const [classifier, regime] = key.split(":") as [ReplayMetrics["scenarios"][number]["classifier"], string];
    const meanStrategy = rows.reduce((sum, row) => sum + row.strategy, 0) / rows.length;
    const meanBenchmark = rows.reduce((sum, row) => sum + row.benchmark, 0) / rows.length;
    const compound = (key: "strategy" | "benchmark") => (rows.reduce((total, row) => total * (1 + row[key]), 1) - 1) * 100;
    const strategyCumulativeReturnPct = compound("strategy");
    const benchmarkCumulativeReturnPct = compound("benchmark");
    return {
      classifier, regime, sessions: rows.length,
      meanStrategyDailyReturnPct: meanStrategy * 100,
      meanBenchmarkDailyReturnPct: meanBenchmark * 100,
      meanExcessDailyReturnPp: (meanStrategy - meanBenchmark) * 100,
      strategyCumulativeReturnPct,
      benchmarkCumulativeReturnPct,
      excessReturnPp: strategyCumulativeReturnPct - benchmarkCumulativeReturnPct,
    };
  }).sort((a, b) => a.classifier.localeCompare(b.classifier) || a.regime.localeCompare(b.regime));
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length < 30) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function requiredWarmup(predicate: RuleSpec["entry"]): number {
  if (predicate.op === "cmp" || predicate.op === "cmp2") return Math.max(indicatorWarmup(predicate.left), predicate.op === "cmp2" ? indicatorWarmup(predicate.right) : 0);
  if (predicate.op === "and" || predicate.op === "or") return Math.max(0, ...predicate.terms.map(requiredWarmup));
  if (predicate.op === "not") return requiredWarmup(predicate.term);
  return 0;
}

function indicatorWarmup(indicator: any): number {
  return indicator && "period" in indicator ? Number(indicator.period) : 0;
}

export const TEMPLATE_BACKTEST_COST_PCT = MODELED_SLIP_FRACTION * 100;
