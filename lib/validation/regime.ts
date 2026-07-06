// Phase 3 learning-core: point-in-time regime features. Pure math over a
// closes series — no hard bull/bear switches, just observable numbers appended
// to each observation's features.regime.* for later interaction terms in the
// Validation Engine / calibration fit (partial-pooled, not a hard router).

export interface RegimeFeatures {
  trend: number | null;       // (50d MA - 200d MA) / 200d MA
  realizedVol: number | null; // 20d stdev of daily returns
  volTercile: "low" | "mid" | "high" | null;
}

function sma(closes: number[], window: number): number | null {
  if (closes.length < window) return null;
  const slice = closes.slice(-window);
  return slice.reduce((a, b) => a + b, 0) / window;
}

function stdevOfReturns(closes: number[], window: number): number | null {
  if (closes.length < window + 1) return null;
  const slice = closes.slice(-(window + 1));
  const returns: number[] = [];
  for (let i = 1; i < slice.length; i++) if (slice[i - 1] > 0) returns.push((slice[i] - slice[i - 1]) / slice[i - 1]);
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// Fixed, documented vol-tercile cut points (annualized-ish daily-vol bands for
// a broad index) — not fit from data, so this never silently drifts.
const VOL_TERCILE_LOW = 0.008;  // ~0.8%/day
const VOL_TERCILE_HIGH = 0.018; // ~1.8%/day

export function computeRegimeFeatures(closes: number[]): RegimeFeatures {
  const ma50 = sma(closes, 50);
  const ma200 = sma(closes, 200);
  const trend = ma50 != null && ma200 != null && ma200 !== 0 ? (ma50 - ma200) / ma200 : null;
  const realizedVol = stdevOfReturns(closes, 20);
  const volTercile: RegimeFeatures["volTercile"] = realizedVol == null ? null
    : realizedVol < VOL_TERCILE_LOW ? "low" : realizedVol > VOL_TERCILE_HIGH ? "high" : "mid";
  return { trend, realizedVol, volTercile };
}
