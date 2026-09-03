// Build 3 — performance-truth metrics. Pure functions over the paper ledger.
// No DB access, no side effects: every function is unit-testable against a
// hand-built fixture. The API route (app/api/agents/performance/metrics)
// loads the rows; this file only does math.
//
// HONESTY CONTRACT: a metric computed from too few points is noise dressed as
// signal. Every estimator that needs a sample returns a Metric with `n` and an
// `insufficient` flag instead of a bare number, so the UI can show
// "insufficient sample" rather than a meaningless Sharpe of 12.3 off 3 trades.

// Trading days per year — annualization factor for daily-sampled ratios.
const TRADING_DAYS = 252;

// Minimum sample sizes below which an estimate is not trustworthy.
export const MIN_RETURNS = 20; // daily returns for Sharpe/Sortino/drawdown
export const MIN_TRADES = 20;  // closed trades for expectancy/profit-factor
export const MIN_CALIB = 10;   // labeled predictions per bin floor (total)

export interface Metric {
  value: number | null; // null when insufficient
  n: number;            // sample size the estimate is built on
  insufficient: boolean;
}

function metric(value: number | null, n: number, min: number): Metric {
  const insufficient = n < min || value === null || !Number.isFinite(value);
  return { value: insufficient ? null : value, n, insufficient };
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Sample standard deviation (n-1). Returns 0 for < 2 points.
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Convert a NAV level series into simple period-over-period returns.
// A gap (missing day) is treated as a single period — callers should pass a
// clean daily series. Non-positive / non-finite prior NAV drops that step.
export function navToReturns(nav: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    const prev = nav[i - 1];
    const cur = nav[i];
    if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) {
      out.push(cur / prev - 1);
    }
  }
  return out;
}

// Annualized Sharpe from daily returns. rfDaily is the per-day risk-free rate
// (default 0 — paper book, cash yield ignored). std==0 => insufficient (no
// dispersion to divide by), not Infinity.
export function sharpe(dailyReturns: number[], rfDaily = 0): Metric {
  const n = dailyReturns.length;
  const excess = dailyReturns.map((r) => r - rfDaily);
  const sd = stdev(excess);
  const value = sd > 0 ? (mean(excess) / sd) * Math.sqrt(TRADING_DAYS) : null;
  return metric(value, n, MIN_RETURNS);
}

// Annualized Sortino — like Sharpe but the denominator penalizes only downside
// deviation (returns below the target, default 0). No downside at all => the
// ratio is undefined (division by zero), reported insufficient rather than ∞.
export function sortino(dailyReturns: number[], targetDaily = 0): Metric {
  const n = dailyReturns.length;
  const excess = dailyReturns.map((r) => r - targetDaily);
  const downside = excess.filter((r) => r < 0);
  // Downside deviation uses N (all periods) in the denominator by convention.
  const dd =
    n > 0 ? Math.sqrt(downside.reduce((a, b) => a + b * b, 0) / n) : 0;
  const value = dd > 0 ? (mean(excess) / dd) * Math.sqrt(TRADING_DAYS) : null;
  return metric(value, n, MIN_RETURNS);
}

// Max drawdown as a negative fraction (e.g. -0.185 = -18.5% peak-to-trough) over
// a NAV level series. 0 when the series only rises. Needs the raw NAV, not
// returns, so gauged on levels.
export function maxDrawdown(nav: number[]): Metric {
  const clean = nav.filter((x) => Number.isFinite(x) && x > 0);
  let peak = -Infinity;
  let maxDD = 0;
  for (const v of clean) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = v / peak - 1; // <= 0
      if (dd < maxDD) maxDD = dd;
    }
  }
  // Drawdown needs a comparable window; reuse MIN_RETURNS on the level count.
  return metric(clean.length >= 2 ? maxDD : null, clean.length, MIN_RETURNS);
}

export interface ClosedTrade {
  pnl_pct: number | null; // realized % return of the trade
}

// Expectancy: average % return per trade = winRate*avgWin - lossRate*|avgLoss|.
// Equivalent to the plain mean of pnl_pct, but we compute component-wise so the
// caller can also surface avg win / avg loss / win rate from the same pass.
export interface ExpectancyResult extends Metric {
  avgWin: number | null;
  avgLoss: number | null; // negative
  winRate: number | null;
  profitFactor: Metric;
}

export function expectancy(trades: ClosedTrade[]): ExpectancyResult {
  const pnls = trades
    .map((t) => t.pnl_pct)
    .filter((x): x is number => x != null && Number.isFinite(x));
  const n = pnls.length;
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x < 0);
  const avgWin = wins.length ? mean(wins) : null;
  const avgLoss = losses.length ? mean(losses) : null;
  const winRate = n ? wins.length / n : null;
  const exp = n ? mean(pnls) : null;

  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : null;

  return {
    ...metric(exp, n, MIN_TRADES),
    avgWin,
    avgLoss,
    winRate,
    profitFactor: metric(pf, n, MIN_TRADES),
  };
}

// Cost drag: how much the spread/slippage applied at fill cost the book, in the
// same % units as returns. gross = net + cost (cost is what we gave up).
export interface CostNetResult {
  netReturnPct: Metric;   // mean realized pnl_pct (already net of spread)
  costPct: Metric;        // mean spread_applied as % of fill
  grossReturnPct: Metric; // net + cost
}

export function costNet(
  trades: { pnl_pct: number | null; spread_applied: number | null; fill_price: number | null }[]
): CostNetResult {
  const rows = trades.filter(
    (t) => t.pnl_pct != null && Number.isFinite(t.pnl_pct)
  );
  const n = rows.length;
  const nets = rows.map((t) => t.pnl_pct as number);
  // spread_applied is a FRACTION of price, not an absolute price offset.
  //
  // THE BUG THIS REPLACES. The old line divided it by fill_price as though it
  // were an offset in currency, which understated the cost by a factor equal to
  // the fill price itself. paper-trade/route.ts fills with a hardcoded
  // `spread: 0.0005` and stores exactly that in spread_applied; every US fill
  // carries 0.00050. So the applied cost is 0.05% (5bps) while costNet reported
  // 0.0005/56.92*100 = 0.0009% for a $57 stock and 0.0001% for a $417 one --
  // understated 57x and 417x respectively, and MORE understated the more
  // expensive the stock.
  //
  // The same file already had it right one function down: `slip()` multiplies
  // realized_slip_pct by 100 with the comment "fraction -> %", and
  // MODELED_SLIP_PCT is declared as 0.05 meaning 5bps. costNet contradicted
  // both. A cost-realism programme that starts from a cost read 57-417x too
  // small starts from the wrong number.
  const costs = rows.map((t) => {
    const s = t.spread_applied;
    if (s == null || !Number.isFinite(s)) return 0;
    return Math.abs(s) * 100;
  });
  const net = n ? mean(nets) : null;
  const cost = n ? mean(costs) : null;
  const gross = net != null && cost != null ? net + cost : null;
  return {
    netReturnPct: metric(net, n, MIN_TRADES),
    costPct: metric(cost, n, MIN_TRADES),
    grossReturnPct: metric(gross, n, MIN_TRADES),
  };
}

// Execution slip (Build 4a): realized slip = fill/expected - 1, recorded per
// fill. Reported as mean % across trades, to compare against the flat slippage
// the fill model *assumes*. Today realized ≈ modeled (same-tick fill), so this
// tile confirms the assumption; once partial/next-bar fills land (4b/4c) the two
// diverge and this becomes the execution-quality truth signal.
export const MODELED_SLIP_PCT = 0.05; // flat 5bps slippage the fill model applies

/**
 * The SAME constant as a fraction — the form the fill path and the simulator want.
 *
 * ONE NUMBER, ONE DEFINITION. It used to exist twice in two units: a bare
 * `spread: 0.0005` literal in app/api/agents/paper-trade/route.ts and
 * MODELED_SLIP_PCT = 0.05 here. Two components holding the same quantity in
 * different units is how costNet came to divide a fraction by a price. Anything
 * that charges or reports this friction imports it from here.
 *
 * WHAT IT ASSUMES, AND WHERE IT BREAKS. 5bps per side is a modelling
 * assumption, not a measurement — no bid/ask is captured at fill, so the
 * "realized" cost in paper_trades is this constant read back. For the current
 * universe (US mega/large caps) at the current size (~$1k orders on a $10k NAV)
 * it is CONSERVATIVE: a $1k order sits inside top-of-book, so the true cost is
 * about a half-spread — under 1bp on AAPL — with no commission at the broker.
 * It stops being conservative for thin names, for India, or if NAV scales to
 * where orders move the book. Report a sensitivity band, never a point estimate.
 */
export const MODELED_SLIP_FRACTION = MODELED_SLIP_PCT / 100;

export function slip(rows: { realized_slip_pct: number | null }[]): Metric {
  const vals = rows
    .map((r) => r.realized_slip_pct)
    .filter((x): x is number => x != null && Number.isFinite(x))
    .map((x) => x * 100); // fraction -> %
  const n = vals.length;
  return metric(n ? mean(vals) : null, n, MIN_TRADES);
}

// Calibration: bucket predictions by score decile and compare the mean predicted
// probability to the realized win rate in each bucket. `predicted` is expected in
// [0,1]; pass analyst_score/100. A well-calibrated model tracks the diagonal.
export interface CalibrationBin {
  bucket: number;     // 0..bins-1
  predicted: number;  // mean predicted p(win) in the bucket
  realized: number;   // realized win rate in the bucket
  n: number;
}
export interface CalibrationResult {
  bins: CalibrationBin[];
  n: number;
  insufficient: boolean;
}

export function calibration(
  points: { predicted: number; win: boolean }[],
  bins = 10
): CalibrationResult {
  const clean = points.filter(
    (p) => Number.isFinite(p.predicted) && p.predicted >= 0 && p.predicted <= 1
  );
  const n = clean.length;
  const buckets: { preds: number[]; wins: number }[] = Array.from(
    { length: bins },
    () => ({ preds: [], wins: 0 })
  );
  for (const p of clean) {
    // predicted==1 maps to the last bucket, not out of range.
    const b = Math.min(bins - 1, Math.floor(p.predicted * bins));
    buckets[b].preds.push(p.predicted);
    if (p.win) buckets[b].wins += 1;
  }
  const out: CalibrationBin[] = buckets
    .map((bk, i) => ({
      bucket: i,
      predicted: bk.preds.length ? mean(bk.preds) : 0,
      realized: bk.preds.length ? bk.wins / bk.preds.length : 0,
      n: bk.preds.length,
    }))
    .filter((b) => b.n > 0);
  return { bins: out, n, insufficient: n < MIN_CALIB };
}
