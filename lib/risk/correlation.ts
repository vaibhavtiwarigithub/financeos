// Daily Per-Holding Risk Analytics — computed aligned-return correlations.
//
// Spec: features/holding-risk-daily/FEATURE_ARCHITECTURE.md — the correlated-cluster
// component "from COMPUTED aligned-return correlations, never the small static
// KNOWN_CORR map alone". This module is PURE math over candle series the cron fetches;
// it has no I/O so the correlation logic is unit-testable in isolation.
//
// For each held symbol it finds co-held names whose daily-return correlation clears a
// threshold, and reports the average correlation to that cluster plus the cluster's
// combined account weight. A symbol with no candles or too little overlap gets
// avgCorr=null → the risk engine treats correlation evidence as MISSING (lower
// confidence), never as "zero correlation, verified".

import type { Candle } from "@/lib/data/technicals";

export interface CorrelationCluster {
  symbol: string;
  avgCorr: number | null;    // avg corr to peers above threshold; null => no computable evidence
  peers: string[];           // co-held symbols correlated at/above threshold
  clusterWeightPct: number;  // fraction [0,1]: this symbol + its peers combined account weight
  computable: boolean;       // true if this symbol had a usable return series
}

// Daily simple returns keyed by trading date, so two symbols align on shared days only.
function dailyReturnsByDate(candles: Candle[]): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...candles].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].close;
    const curr = sorted[i].close;
    if (Number.isFinite(prev) && Number.isFinite(curr) && prev > 0 && curr > 0) {
      out.set(sorted[i].date, (curr - prev) / prev);
    }
  }
  return out;
}

// Pearson correlation over the shared trading days of two return series. Returns null
// when the overlap is too small or either series has zero variance (corr undefined).
function pearsonOnShared(
  a: Map<string, number>,
  b: Map<string, number>,
  minOverlap: number,
): number | null {
  const ax: number[] = [];
  const bx: number[] = [];
  for (const [date, ra] of a) {
    const rb = b.get(date);
    if (rb != null) { ax.push(ra); bx.push(rb); }
  }
  const n = ax.length;
  if (n < minOverlap) return null;
  const meanA = ax.reduce((s, v) => s + v, 0) / n;
  const meanB = bx.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = ax[i] - meanA;
    const db = bx[i] - meanB;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return null;
  const r = cov / Math.sqrt(va * vb);
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

export interface CorrelationOptions {
  threshold?: number;  // min |corr| to count a name as a cluster peer (default 0.6)
  minOverlap?: number; // min shared trading days for a usable pair (default 30)
}

/**
 * Compute per-symbol correlated clusters from candle series + account weights.
 * Pure: same inputs → same output. `weightBySymbol` values are fractions in [0,1].
 */
export function computeCorrelationClusters(
  candlesBySymbol: Map<string, Candle[]>,
  weightBySymbol: Map<string, number>,
  opts: CorrelationOptions = {},
): Map<string, CorrelationCluster> {
  const threshold = opts.threshold ?? 0.6;
  const minOverlap = opts.minOverlap ?? 30;

  const symbols = Array.from(candlesBySymbol.keys());
  const returns = new Map<string, Map<string, number>>();
  for (const s of symbols) {
    const r = dailyReturnsByDate(candlesBySymbol.get(s) ?? []);
    if (r.size >= minOverlap) returns.set(s, r);
  }

  // Pairwise correlations (upper triangle), reused for both symbols in each pair.
  const corr = new Map<string, Map<string, number>>();
  const usable = Array.from(returns.keys());
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const s1 = usable[i], s2 = usable[j];
      const r = pearsonOnShared(returns.get(s1)!, returns.get(s2)!, minOverlap);
      if (r == null) continue;
      if (!corr.has(s1)) corr.set(s1, new Map());
      if (!corr.has(s2)) corr.set(s2, new Map());
      corr.get(s1)!.set(s2, r);
      corr.get(s2)!.set(s1, r);
    }
  }

  const out = new Map<string, CorrelationCluster>();
  for (const s of symbols) {
    const computable = returns.has(s);
    if (!computable) {
      out.set(s, { symbol: s, avgCorr: null, peers: [], clusterWeightPct: weightBySymbol.get(s) ?? 0, computable: false });
      continue;
    }
    const neighbors = corr.get(s) ?? new Map<string, number>();
    const peers: string[] = [];
    const peerCorrs: number[] = [];
    for (const [other, r] of neighbors) {
      if (Math.abs(r) >= threshold) { peers.push(other); peerCorrs.push(Math.abs(r)); }
    }
    const avgCorr = peerCorrs.length ? peerCorrs.reduce((a, b) => a + b, 0) / peerCorrs.length : 0;
    let clusterWeightPct = weightBySymbol.get(s) ?? 0;
    for (const p of peers) clusterWeightPct += weightBySymbol.get(p) ?? 0;
    out.set(s, {
      symbol: s,
      avgCorr,                 // 0 when computable but no peer clears the threshold (verified low, not missing)
      peers: peers.sort(),
      clusterWeightPct: Math.min(1, clusterWeightPct),
      computable: true,
    });
  }
  return out;
}
