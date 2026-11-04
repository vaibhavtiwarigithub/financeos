import { createHash } from "node:crypto";

export type StoredDailyReturn = {
  symbol: string;
  session_date: string;
  simple_return: number | string;
  previous_session_date: string;
  price_basis: "adjusted_close" | "raw_close";
  source: string;
  available_at: string;
};

export type StoredEventOutcome = {
  entryDate: string;
  exitDate: string;
  sessionsUsed: number;
  fwdReturn: number;
  benchmarkReturn: number | null;
  benchmarkNeutralReturn: number | null;
  matchedControlMean: number | null;
  matchedControlN: number;
  matchedControlDelta: number | null;
  maxAdverseExcursion: number;
  maxFavorableExcursion: number;
  forwardVolatility: number;
  maxDrawdown: number;
  inputFingerprint: string;
};

function latestPerSession(rows: readonly StoredDailyReturn[], symbol: string): StoredDailyReturn[] {
  const byDate = new Map<string, StoredDailyReturn>();
  for (const row of rows) {
    if (row.symbol.toUpperCase() !== symbol.toUpperCase()) continue;
    const value = Number(row.simple_return);
    const availableAt = Date.parse(row.available_at);
    if (!Number.isFinite(value) || value <= -1 || !Number.isFinite(availableAt) || availableAt > Date.now()) continue;
    const current = byDate.get(row.session_date);
    if (!current || current.available_at < row.available_at
      || (current.available_at === row.available_at && `${row.source}|${row.simple_return}` > `${current.source}|${current.simple_return}`)) byDate.set(row.session_date, row);
  }
  return [...byDate.values()].sort((a, b) => a.session_date.localeCompare(b.session_date));
}

function closeAt(date: string, market: string): number {
  if (market === "us") {
    const noonUtc = new Date(`${date}T12:00:00.000Z`);
    const offset = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "shortOffset" })
      .formatToParts(noonUtc).find((part) => part.type === "timeZoneName")?.value ?? "GMT-5";
    const match = offset.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!match) return Number.NaN;
    const minutes = (Number(match[2]) * 60 + Number(match[3] ?? 0)) * (match[1] === "+" ? 1 : -1);
    return Date.parse(`${date}T16:00:00.000Z`) - minutes * 60_000;
  }
  return Number.NaN;
}

function compound(rows: readonly StoredDailyReturn[]): number | null {
  if (!rows.length) return null;
  let product = 1;
  for (const row of rows) {
    const value = Number(row.simple_return);
    if (!Number.isFinite(value) || value <= -1) return null;
    product *= 1 + value;
  }
  return Number.isFinite(product) ? product - 1 : null;
}

function closePathStats(rows: readonly StoredDailyReturn[]) {
  const values = rows.map((row) => Number(row.simple_return));
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const volatility = values.length > 1
    ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1))
    : 0;
  let wealth = 1;
  let peak = 1;
  let worstRelativeToEntry = 0;
  let bestRelativeToEntry = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    wealth *= 1 + value;
    peak = Math.max(peak, wealth);
    worstRelativeToEntry = Math.min(worstRelativeToEntry, wealth - 1);
    bestRelativeToEntry = Math.max(bestRelativeToEntry, wealth - 1);
    maxDrawdown = Math.min(maxDrawdown, wealth / peak - 1);
  }
  return { volatility, maxAdverseExcursion: worstRelativeToEntry, maxFavorableExcursion: bestRelativeToEntry, maxDrawdown };
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function marketState(rows: readonly StoredDailyReturn[]): { trend: number; volatility: number } | null {
  if (rows.length < 20) return null;
  const window = rows.slice(-20);
  for (let i = 1; i < window.length; i++) {
    if (window[i].previous_session_date !== window[i - 1].session_date) return null;
  }
  const values = window.map((row) => Number(row.simple_return));
  if (values.some((value) => !Number.isFinite(value) || value <= -1)) return null;
  let product = 1;
  for (const value of values) product *= 1 + value;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { trend: product - 1, volatility: Math.sqrt(variance) };
}

function previousChainIsComplete(rows: readonly StoredDailyReturn[], anchorDate: string): boolean {
  let previous = anchorDate;
  for (const row of rows) {
    if (row.previous_session_date !== previous) return false;
    previous = row.session_date;
  }
  return true;
}

function matchedControlComparison(input: {
  subject: StoredDailyReturn[];
  benchmark: StoredDailyReturn[];
  occurredAtMs: number;
  eventEntryDate: string;
  horizon: number;
  compatibleBasis: boolean;
  priceBasis: StoredDailyReturn["price_basis"];
}): { mean: number | null; n: number; selectedRows: StoredDailyReturn[] } {
  if (!input.compatibleBasis) return { mean: null, n: 0, selectedRows: [] };
  const eventHistory = input.benchmark.filter((row) => closeAt(row.session_date, "us") < input.occurredAtMs);
  const targetState = marketState(eventHistory);
  if (!targetState) return { mean: null, n: 0, selectedRows: [] };

  const benchmarkByDate = new Map(input.benchmark.map((row) => [row.session_date, row]));
  const subjectByDate = new Map(input.subject.map((row) => [row.session_date, row]));
  const candidates: { distance: number; excess: number; rows: StoredDailyReturn[] }[] = [];
  for (let anchorIndex = 19; anchorIndex < input.benchmark.length; anchorIndex++) {
    const anchor = input.benchmark[anchorIndex];
    if (closeAt(anchor.session_date, "us") >= input.occurredAtMs || anchor.session_date >= input.eventEntryDate) continue;
    if (anchor.price_basis !== input.priceBasis) continue;
    const history = input.benchmark.slice(anchorIndex - 19, anchorIndex + 1);
    const state = marketState(history);
    if (!state) continue;
    const bWindow = input.benchmark.slice(anchorIndex + 1, anchorIndex + 1 + input.horizon);
    if (bWindow.length !== input.horizon || bWindow[bWindow.length - 1].session_date >= input.eventEntryDate) continue;
    if (!previousChainIsComplete(bWindow, anchor.session_date)) continue;
    const dates = bWindow.map((row) => row.session_date);
    const sWindow = dates.map((date) => subjectByDate.get(date));
    if (sWindow.some((row) => !row)) continue;
    const alignedSubject = sWindow as StoredDailyReturn[];
    const subjectAnchor = subjectByDate.get(anchor.session_date);
    if (!subjectAnchor) continue;
    if (!previousChainIsComplete(alignedSubject, anchor.session_date)) continue;
    if (bWindow.some((row) => row.price_basis !== anchor.price_basis)
      || alignedSubject.some((row) => row.price_basis !== subjectAnchor.price_basis)
      || subjectAnchor.price_basis !== anchor.price_basis) continue;
    const subjectReturn = compound(alignedSubject);
    const benchmarkReturn = compound(bWindow);
    if (subjectReturn == null || benchmarkReturn == null) continue;
    const trendScale = Math.max(0.01, Math.abs(targetState.trend));
    const volScale = Math.max(0.005, targetState.volatility);
    const distance = Math.hypot((state.trend - targetState.trend) / trendScale, (state.volatility - targetState.volatility) / volScale);
    candidates.push({ distance, excess: subjectReturn - benchmarkReturn, rows: [...alignedSubject, ...bWindow] });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const selected = candidates.slice(0, 20);
  const mean = selected.length >= 20 ? selected.reduce((sum, item) => sum + item.excess, 0) / selected.length : null;
  return { mean, n: selected.length, selectedRows: selected.flatMap((item) => item.rows) };
}

/**
 * Uses only already-persisted daily returns. The event-session return is skipped:
 * entry is the first close strictly after the public event time, so the first
 * measurable forward interval is the following session. Relative returns require
 * identical dates and a matching adjusted/raw price basis.
 */
export function computeStoredEventOutcome(input: {
  subjectRows: readonly StoredDailyReturn[];
  benchmarkRows: readonly StoredDailyReturn[];
  subjectSymbol: string;
  benchmarkSymbol: string;
  occurredAt: string;
  market: string;
  horizonSessions: number;
}): StoredEventOutcome | null {
  if (input.horizonSessions <= 0 || !Number.isFinite(Date.parse(input.occurredAt))) return null;
  const subject = latestPerSession(input.subjectRows, input.subjectSymbol);
  const benchmark = latestPerSession(input.benchmarkRows, input.benchmarkSymbol);
  const entryDate = benchmark.find((row) => closeAt(row.session_date, input.market) > Date.parse(input.occurredAt))?.session_date;
  if (!entryDate) return null;

  const benchmarkWindow = benchmark.filter((row) => row.session_date > entryDate).slice(0, input.horizonSessions);
  if (benchmarkWindow.length !== input.horizonSessions) return null;
  const dates = benchmarkWindow.map((row) => row.session_date);
  const subjectByDate = new Map(subject.map((row) => [row.session_date, row]));
  const benchmarkByDate = new Map(benchmark.map((row) => [row.session_date, row]));
  const subjectEntry = subjectByDate.get(entryDate);
  const benchmarkEntry = benchmarkByDate.get(entryDate);
  if (!subjectEntry || !benchmarkEntry) return null;
  const subjectWindow = dates.map((date) => subjectByDate.get(date));
  if (subjectWindow.some((row) => !row)) return null;
  const alignedSubject = subjectWindow as StoredDailyReturn[];
  const subjectBasis = new Set([subjectEntry, ...alignedSubject].map((row) => row.price_basis));
  const benchmarkBasis = new Set([benchmarkEntry, ...benchmarkWindow].map((row) => row.price_basis));
  if (subjectBasis.size !== 1 || benchmarkBasis.size !== 1) return null;

  let expectedPreviousDate = entryDate;
  for (let i = 0; i < dates.length; i++) {
    const subjectRow = alignedSubject[i];
    const benchmarkRow = benchmarkWindow[i];
    if (subjectRow.previous_session_date !== expectedPreviousDate || benchmarkRow.previous_session_date !== expectedPreviousDate) return null;
    expectedPreviousDate = dates[i];
  }

  const fwdReturn = compound(alignedSubject);
  const benchmarkReturn = compound(benchmarkWindow);
  if (fwdReturn == null || benchmarkReturn == null) return null;
  const comparableBasis = [...subjectBasis][0] === [...benchmarkBasis][0];
  const matched = matchedControlComparison({
    subject, benchmark, occurredAtMs: Date.parse(input.occurredAt), eventEntryDate: entryDate,
    horizon: input.horizonSessions, compatibleBasis: comparableBasis, priceBasis: [...benchmarkBasis][0],
  });
  const pathStats = closePathStats(alignedSubject);
  const benchmarkNeutralReturn = comparableBasis ? fwdReturn - benchmarkReturn : null;
  const rowsForHash = [...alignedSubject, ...benchmarkWindow].map((row) =>
    `${row.symbol}:${row.session_date}:${row.simple_return}:${row.price_basis}:${row.source}:${row.available_at}`,
  );

  return {
    entryDate,
    exitDate: dates[dates.length - 1],
    sessionsUsed: input.horizonSessions,
    fwdReturn,
    benchmarkReturn: comparableBasis ? benchmarkReturn : null,
    benchmarkNeutralReturn,
    matchedControlMean: matched.mean,
    matchedControlN: matched.n,
    matchedControlDelta: matched.mean == null || benchmarkNeutralReturn == null ? null : benchmarkNeutralReturn - matched.mean,
    maxAdverseExcursion: pathStats.maxAdverseExcursion,
    maxFavorableExcursion: pathStats.maxFavorableExcursion,
    forwardVolatility: pathStats.volatility,
    maxDrawdown: pathStats.maxDrawdown,
    inputFingerprint: hash(["policy-event-study-v1", input.subjectSymbol, input.benchmarkSymbol, input.occurredAt, String(input.horizonSessions), ...rowsForHash, ...matched.selectedRows.map((row) => `${row.symbol}:${row.session_date}:${row.simple_return}:${row.price_basis}:${row.source}:${row.available_at}`)]),
  };
}
