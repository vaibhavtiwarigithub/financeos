// Company macro-exposure for India (measure-only). A stock's sensitivity to market, USD/INR, Brent and India VIX
// moves, estimated by OLS on its own daily returns. Deterministic: no model, no text. Nothing reads it for scoring.
//
// Why: macro is one number per market per day, so it cannot rank symbols (constant => zero cross-sectional IC).
// Regime x exposure is the shape that can vary by company. This module only measures the exposure half.

export const EXPOSURE_FACTORS = ["market", "usdinr", "brent", "vix"] as const;
export type ExposureFactor = (typeof EXPOSURE_FACTORS)[number];

/** Series (from india_macro_observations) that supply each factor level. */
export const FACTOR_SERIES: Record<ExposureFactor, string> = {
  market: "nifty50_close",
  usdinr: "usdinr_spot",
  brent: "brent_front",
  vix: "india_vix",
};

export const MIN_EXPOSURE_OBS = 120;
export const MIN_FACTOR_COVERAGE = 0.8;
export const SIGNIFICANT_T = 2;

export interface SessionReturn {
  session_date: string;
  previous_session_date: string;
  simple_return: number;
}

export type FactorLevels = Record<ExposureFactor, Map<string, number>>; // date -> level

export interface ExposureResult {
  ok: boolean;
  reason?: "insufficient_observations" | "insufficient_factor_coverage" | "singular";
  n_obs: number;
  factor_coverage: number;
  window_start: string | null;
  window_end: string | null;
  intercept?: number;
  betas?: Record<ExposureFactor, number>;
  tstats?: Record<ExposureFactor, number>;
  r2?: number;
  significant?: ExposureFactor[];
}

/** Change in a factor between a stock's previous and current session; null if either level is missing. */
function factorChange(levels: Map<string, number>, from: string, to: string): number | null {
  const a = levels.get(from);
  const b = levels.get(to);
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return b / a - 1;
}

/** Gauss-Jordan inverse of a small symmetric matrix; null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-12) return null;
    [a[c], a[p]] = [a[p], a[c]];
    const d = a[c][c];
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = a[r][c];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j];
    }
  }
  return a.map((row) => row.slice(n));
}

/** OLS with intercept. X rows are regressors without the constant. */
export function ols(y: number[], X: number[][]): { coef: number[]; t: number[]; r2: number } | null {
  const n = y.length;
  const k = (X[0]?.length ?? 0) + 1;
  if (n <= k) return null;
  const rows = X.map((r) => [1, ...r]);
  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      xty[a] += rows[i][a] * y[i];
      for (let b = 0; b < k; b++) xtx[a][b] += rows[i][a] * rows[i][b];
    }
  }
  const inv = invert(xtx);
  if (!inv) return null;
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let sse = 0;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const fit = rows[i].reduce((s, v, j) => s + v * coef[j], 0);
    sse += (y[i] - fit) ** 2;
    sst += (y[i] - mean) ** 2;
  }
  const sigma2 = sse / (n - k);
  const t = coef.map((c, j) => {
    const se = Math.sqrt(Math.max(sigma2 * inv[j][j], 0));
    return se > 0 ? c / se : 0;
  });
  return { coef, t, r2: sst > 0 ? 1 - sse / sst : 0 };
}

/**
 * Regress a symbol's daily returns on factor changes measured over the SAME session pair (previous -> current session),
 * so exchange holidays never misalign the data. Sessions with any missing factor level are dropped; coverage is reported.
 */
export function computeExposure(returns: readonly SessionReturn[], levels: FactorLevels): ExposureResult {
  const y: number[] = [];
  const X: number[][] = [];
  let first: string | null = null;
  let last: string | null = null;
  for (const r of returns) {
    if (!Number.isFinite(r.simple_return)) continue;
    const row: number[] = [];
    let complete = true;
    for (const f of EXPOSURE_FACTORS) {
      const ch = factorChange(levels[f], r.previous_session_date, r.session_date);
      if (ch == null) { complete = false; break; }
      row.push(ch);
    }
    if (!complete) continue;
    y.push(r.simple_return);
    X.push(row);
    if (first == null || r.session_date < first) first = r.session_date;
    if (last == null || r.session_date > last) last = r.session_date;
  }
  const coverage = returns.length ? y.length / returns.length : 0;
  const base = { n_obs: y.length, factor_coverage: coverage, window_start: first, window_end: last };
  if (coverage < MIN_FACTOR_COVERAGE) return { ok: false, reason: "insufficient_factor_coverage", ...base };
  if (y.length < MIN_EXPOSURE_OBS) return { ok: false, reason: "insufficient_observations", ...base };
  const fit = ols(y, X);
  if (!fit) return { ok: false, reason: "singular", ...base };
  const betas = {} as Record<ExposureFactor, number>;
  const tstats = {} as Record<ExposureFactor, number>;
  EXPOSURE_FACTORS.forEach((f, i) => { betas[f] = fit.coef[i + 1]; tstats[f] = fit.t[i + 1]; });
  return {
    ok: true, ...base, intercept: fit.coef[0], betas, tstats, r2: fit.r2,
    significant: EXPOSURE_FACTORS.filter((f) => Math.abs(tstats[f]) >= SIGNIFICANT_T),
  };
}
