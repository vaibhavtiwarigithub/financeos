// Edge/Factor Discovery P1 — Information Coefficient (IC) gate. MEASURE-ONLY.
//
// The IC answers the only question that matters: does an edge's cross-sectional
// ranking actually predict forward returns? Computed on the BROAD historical
// candle universe (NOT our few paper fills). For each edge × horizon we take the
// rank correlation (Spearman) between the edge value and the realized forward
// return across the universe at each as-of date, then aggregate:
//   mean IC, IC vol, IR = mean/std, and a Newey-West t-stat that corrects for the
//   autocorrelation induced by OVERLAPPING forward-return windows (naive IID
//   t-stats overstate significance here).
// Decay is read from IC across horizons. Nothing here sizes or trades anything;
// it writes edge_ic_history and an ADVISORY edge lifecycle status.
import { EDGES } from "@/lib/edges/registry";
import { resolveCandles, resolveBenchmark } from "@/lib/edges/data";
import { neweyWestLag } from "@/lib/edges/evidence";
import type { Candle } from "@/lib/data/technicals";
import type { Market } from "@/lib/edges/types";
import crypto from "node:crypto";

// ── rank / correlation ────────────────────────────────────────────────────────
function ranks(xs: number[]): number[] {
  const idx = xs.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank (1-based) for ties
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}
export function spearman(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 3) return NaN;
  return pearson(ranks(a), ranks(b));
}

// Newey-West standard error OF THE MEAN of a series with autocorrelation up to `lag`.
function neweyWestSEofMean(x: number[], lag: number): number {
  const n = x.length;
  if (n < 2) return NaN;
  const mean = x.reduce((s, v) => s + v, 0) / n;
  const d = x.map(v => v - mean);
  let g0 = 0; for (let t = 0; t < n; t++) g0 += d[t] * d[t];
  g0 /= n;
  let sum = g0;
  for (let k = 1; k <= Math.min(lag, n - 1); k++) {
    let gk = 0; for (let t = k; t < n; t++) gk += d[t] * d[t - k];
    gk /= n;
    const w = 1 - k / (lag + 1); // Bartlett kernel
    sum += 2 * w * gk;
  }
  return sum > 0 ? Math.sqrt(sum / n) : NaN; // SE of the mean
}

// ── candle indexing helpers ───────────────────────────────────────────────────
function idxOnOrBefore(candles: Candle[], date: string): number {
  // last index with candles[i].date <= date; assumes ascending. -1 if none.
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (candles[m].date <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

export interface IcRow {
  edgeId: string; market: Market; horizon: number; windowEnd: string;
  meanIC: number; icIR: number; tStat: number; nObs: number; statusAfter: string;
  segmentType: "market" | "sector";
  segmentValue: string;
}

export interface IcRunReport {
  market: Market;
  symbolsResolved: number;
  asOfDates: number;
  horizons: number[];
  rows: number;
  sectorsEvaluated: string[];
  datasetFingerprint: string;
}

// Priored (academically-documented) factors clear at t≈2; a data-mined edge would
// need t>3 / FDR. All P0 edges are priored, so the shadow hurdle is 2.
const T_HURDLE_PRIOR = 2.0;
const IC_MIN = 0.02;

export const MIN_IC_OBSERVATIONS = 36;

export function classifyEdgeIC(meanIC: number, tStat: number, nObs: number): string {
  if (!Number.isFinite(meanIC) || !Number.isFinite(tStat) || nObs < MIN_IC_OBSERVATIONS) return "measure_only";
  if (meanIC >= IC_MIN && Math.abs(tStat) >= T_HURDLE_PRIOR && meanIC > 0) return "shadow_eligible";
  if (meanIC <= -IC_MIN && Math.abs(tStat) >= T_HURDLE_PRIOR) return "benched_negative";
  return "measure_only";
}

const NON_EQUITY_SECTORS = new Set([
  "other", "diversified equity", "international equity", "fixed income",
  "commodities", "digital assets", "unknown", "n/a",
]);

export function normalizeSectorSegment(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!normalized || NON_EQUITY_SECTORS.has(normalized.toLowerCase())) return null;
  return normalized;
}

function summarizeIc(ics: number[], horizon: number, step: number) {
  const nObs = ics.length;
  const meanIC = nObs ? ics.reduce((sum, value) => sum + value, 0) / nObs : NaN;
  const se = neweyWestSEofMean(ics, neweyWestLag(horizon, step));
  const std = nObs > 1
    ? Math.sqrt(ics.reduce((sum, value) => sum + (value - meanIC) ** 2, 0) / nObs)
    : NaN;
  const icIR = std > 0 ? meanIC / std : NaN;
  const tStat = se > 0 ? meanIC / se : NaN;
  return { meanIC, icIR, tStat, nObs, statusAfter: classifyEdgeIC(meanIC, tStat, nObs) };
}

export async function computeEdgeIC(opts: {
  market: Market;
  symbols: string[];
  horizons?: number[];
  maxDates?: number;
  stepDays?: number;   // sample every Nth trading day to reduce overlap
  sectors?: Record<string, string | null | undefined>;
  candleDays?: number; // history depth (calendar days) — deeper = multi-year IC
}): Promise<{ rows: IcRow[]; catalogStatus: Record<string, string>; report: IcRunReport }> {
  const { market, symbols } = opts;
  const horizons = opts.horizons ?? [5, 10, 20];
  const maxDates = Math.min(120, opts.maxDates ?? 60);
  const step = Math.max(1, opts.stepDays ?? 5);

  const bench = await resolveBenchmark(market, opts.candleDays);
  const resolved: { symbol: string; candles: Candle[] }[] = [];
  for (const sym of symbols) {
    const { candles } = await resolveCandles(sym, market, opts.candleDays);
    if (candles.length) resolved.push({ symbol: sym, candles });
  }

  const datasetFingerprint = crypto.createHash("sha256").update(JSON.stringify({
    market,
    benchmark: bench.candles.map(c => [c.date, c.open, c.high, c.low, c.close, c.volume]),
    symbols: resolved
      .slice()
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map(r => [r.symbol, r.candles.map(c => [c.date, c.open, c.high, c.low, c.close, c.volume])]),
  })).digest("hex");

  // As-of dates = benchmark trading days, sampled every `step`, leaving room for the
  // longest forward horizon at the end.
  const benchDates = bench.candles.map(c => c.date);
  const maxH = Math.max(...horizons);
  const usableEnd = benchDates.length - maxH - 1;
  const sampled: string[] = [];
  for (let i = usableEnd; i >= 0 && sampled.length < maxDates; i -= step) sampled.push(benchDates[i]);
  sampled.reverse();

  const windowEnd = benchDates[benchDates.length - 1] ?? new Date().toISOString().slice(0, 10);
  const rows: IcRow[] = [];
  const catalogStatus: Record<string, string> = {};
  const sectorsEvaluated = new Set<string>();

  for (const edge of EDGES) {
    for (const h of horizons) {
      const icBySegment = new Map<string, number[]>([["market\u0000all", []]]);
      for (const t of sampled) {
        const observations: Array<{ edge: number; forward: number; sector: string | null }> = [];
        const benchSlice = bench.candles.filter(c => c.date <= t);
        for (const r of resolved) {
          const pt = idxOnOrBefore(r.candles, t);
          if (pt < 0 || pt + h >= r.candles.length) continue;
          const candlesAsOf = r.candles.slice(0, pt + 1);
          if (candlesAsOf.length < edge.minCandles) continue;
          const raw = edge.compute({ symbol: r.symbol, market, asOf: t, candles: candlesAsOf, benchmark: benchSlice });
          if (raw == null || !Number.isFinite(raw)) continue;
          const c0 = r.candles[pt].close, cH = r.candles[pt + h].close;
          if (!(c0 > 0) || !Number.isFinite(cH)) continue;
          const fwd = cH / c0 - 1;
          // For edges whose expected_sign is -1 (lower raw = better), flip so a
          // positive IC always means "the edge ranks winners above losers".
          observations.push({
            edge: edge.expectedSign < 0 ? -raw : raw,
            forward: fwd,
            sector: normalizeSectorSegment(opts.sectors?.[r.symbol]),
          });
        }

        if (observations.length >= 5) {
          const ic = spearman(observations.map(o => o.edge), observations.map(o => o.forward));
          if (Number.isFinite(ic)) icBySegment.get("market\u0000all")!.push(ic);
        }

        const bySector = new Map<string, typeof observations>();
        for (const observation of observations) {
          if (!observation.sector) continue;
          const group = bySector.get(observation.sector) ?? [];
          group.push(observation);
          bySector.set(observation.sector, group);
        }
        for (const [sector, group] of bySector) {
          if (group.length < 5) continue;
          const ic = spearman(group.map(o => o.edge), group.map(o => o.forward));
          if (!Number.isFinite(ic)) continue;
          const key = `sector\u0000${sector}`;
          const series = icBySegment.get(key) ?? [];
          series.push(ic);
          icBySegment.set(key, series);
          sectorsEvaluated.add(sector);
        }
      }
      for (const [key, ics] of icBySegment) {
        const [segmentType, segmentValue] = key.split("\u0000") as ["market" | "sector", string];
        rows.push({
          edgeId: edge.id,
          market,
          horizon: h,
          windowEnd,
          segmentType,
          segmentValue,
          ...summarizeIc(ics, h, step),
        });
      }
    }
    // Advisory edge status = best across horizons (shadow_eligible if any horizon clears).
    const mine = rows.filter(r => r.edgeId === edge.id && r.segmentType === "market");
    catalogStatus[edge.id] = mine.some(r => r.statusAfter === "shadow_eligible")
      ? "shadow_eligible"
      : mine.some(r => r.statusAfter === "benched_negative") ? "benched_negative" : "measure_only";
  }

  return {
    rows,
    catalogStatus,
    report: {
      market,
      symbolsResolved: resolved.length,
      asOfDates: sampled.length,
      horizons,
      rows: rows.length,
      sectorsEvaluated: [...sectorsEvaluated].sort(),
      datasetFingerprint,
    },
  };
}
