// Forward-coverage resolution + skip accounting for label maturation.
//
// The 2026-08-16 incident: `label-maturation` returned {matured:0, skipped:800}
// for 25 days and every monitoring layer read it as healthy. Two defects made
// that outcome deterministic, and both are the same mistake — deciding on ROW
// EXISTENCE instead of FORWARD-SESSION COVERAGE of the requested window:
//
//  1. usCandles() returned any non-empty cached slice (`if (cached.length > 0)
//     return cached`). sinceDate was decisionDate−5d, so one stale-but-present
//     price_cache row satisfied it and the provider fallback below it was
//     UNREACHABLE. Coverage could never self-heal; labels froze at 2026-07-22.
//  2. The per-run candle memo was keyed `market:symbol` but spanned ALL
//     horizons, so an h2 request's narrow window was reused for a later h20
//     request of the same symbol and starved it.
//
// CandleResolver fixes both: every request re-tests coverage of ITS OWN
// (decisionDate, horizonDays) window against the accumulated series, widens the
// cache read when an earlier date is requested, and falls through to the
// provider exactly once per symbol per run when coverage is still short.

export type LabelCandle = { date: string; close: number; high: number; low: number };

export type ForwardWindow = {
  /** First candle on/after the decision date — the entry bar. */
  entry: LabelCandle;
  /** Candles strictly after the entry bar; length >= horizonDays. */
  after: LabelCandle[];
};

/**
 * The entry bar plus `horizonDays` forward sessions, or null when the series
 * does not actually cover that window. This is the coverage test — never
 * `candles.length > 0`, never a row count.
 */
export function forwardWindow(
  candles: LabelCandle[],
  decisionDate: string,
  horizonDays: number,
): ForwardWindow | null {
  const onOrAfter = candles.filter((c) => c.date >= decisionDate);
  const entry = onOrAfter[0];
  if (!entry) return null;
  const after = onOrAfter.filter((c) => c.date > entry.date);
  if (after.length < horizonDays) return null;
  return { entry, after };
}

export function hasForwardCoverage(
  candles: LabelCandle[],
  decisionDate: string,
  horizonDays: number,
): boolean {
  return forwardWindow(candles, decisionDate, horizonDays) !== null;
}

/** Union by date, ascending. Later sources win on a date collision. */
export function mergeCandles(a: LabelCandle[], b: LabelCandle[]): LabelCandle[] {
  const byDate = new Map<string, LabelCandle>();
  for (const c of [...a, ...b]) {
    if (c && typeof c.date === "string" && Number.isFinite(c.close)) byDate.set(c.date, c);
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

export type CandleLoaders = {
  /** Cheap local source (price_cache). May legitimately return a stale slice. */
  cache: (market: string, symbol: string, since: string) => Promise<LabelCandle[]>;
  /** Authoritative provider fetch. Called at most once per symbol per run. */
  provider: (market: string, symbol: string) => Promise<LabelCandle[]>;
};

export class CandleResolver {
  private series = new Map<string, LabelCandle[]>();
  private cachedSince = new Map<string, string>();
  private providerTried = new Set<string>();
  /** ponytail: per-key promise chain = mutex. Preserves "one provider fetch per
   *  symbol per run" without the old memo's range blindness. */
  private queue = new Map<string, Promise<unknown>>();

  providerFetches = 0;
  cacheReads = 0;

  constructor(private loaders: CandleLoaders) {}

  resolve(
    market: string,
    symbol: string,
    decisionDate: string,
    horizonDays: number,
    since: string,
  ): Promise<LabelCandle[]> {
    const key = `${market}:${symbol}`;
    const prior = this.queue.get(key) ?? Promise.resolve();
    const next = prior.then(
      () => this.resolveOnce(key, market, symbol, decisionDate, horizonDays, since),
      () => this.resolveOnce(key, market, symbol, decisionDate, horizonDays, since),
    );
    this.queue.set(key, next.then(() => {}, () => {}));
    return next;
  }

  private async resolveOnce(
    key: string,
    market: string,
    symbol: string,
    decisionDate: string,
    horizonDays: number,
    since: string,
  ): Promise<LabelCandle[]> {
    let series = this.series.get(key) ?? [];

    // Widen the cache read whenever this request reaches further back than any
    // previous one (a later horizon can ask for an older decision date).
    const prevSince = this.cachedSince.get(key);
    if (prevSince === undefined || since < prevSince) {
      this.cacheReads++;
      const cached = await this.loaders.cache(market, symbol, since).catch(() => [] as LabelCandle[]);
      series = mergeCandles(series, cached);
      this.series.set(key, series);
      this.cachedSince.set(key, since);
    }

    if (hasForwardCoverage(series, decisionDate, horizonDays)) return series;

    // Coverage short — a present-but-stale cache must NOT short-circuit this.
    if (!this.providerTried.has(key)) {
      this.providerTried.add(key);
      this.providerFetches++;
      const fetched = await this.loaders.provider(market, symbol).catch(() => [] as LabelCandle[]);
      series = mergeCandles(series, fetched);
      this.series.set(key, series);
    }
    return series;
  }
}

export type SkipReason =
  | "no_candles"
  | "window_incomplete"
  | "no_entry_price"
  | "label_unavailable"
  | "insert_failed"
  | "exception";

/** Skip counts by reason AND by symbol — a zero-output run must say why. */
export class SkipLedger {
  readonly byReason: Partial<Record<SkipReason, number>> = {};
  private bySymbolMap = new Map<string, number>();
  total = 0;

  add(reason: SkipReason, market: string, symbol: string): void {
    this.total++;
    this.byReason[reason] = (this.byReason[reason] ?? 0) + 1;
    const key = `${market}:${symbol}:${reason}`;
    this.bySymbolMap.set(key, (this.bySymbolMap.get(key) ?? 0) + 1);
  }

  /** Worst offenders first — the symbols actually blocking the backlog. */
  topSymbols(limit = 15): Array<{ key: string; count: number }> {
    return [...this.bySymbolMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
      .slice(0, limit);
  }
}

/**
 * Second scan start offset, rotating by day so a permanently-failing oldest
 * prefix cannot monopolise every run's budget. Deterministic: same day and
 * same total ⇒ same offset, so a run is replayable.
 */
export function rotatingOffset(total: number, pageSize: number, epochDay: number): number {
  if (!Number.isFinite(total) || total <= pageSize || pageSize <= 0) return 0;
  const pages = Math.ceil(total / pageSize);
  return (((epochDay % pages) + pages) % pages) * pageSize;
}

export const epochDay = (now = Date.now()) => Math.floor(now / 86_400_000);
