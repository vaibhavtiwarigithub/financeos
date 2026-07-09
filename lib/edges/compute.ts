// Edge/Factor Discovery P0 — compute orchestration. MEASURE-ONLY.
// For a market + bounded symbol list + as-of date(s): resolve candles (cached),
// compute each edge's RAW value per symbol as-of the date (no look-ahead), then
// cross-sectionally z-score per (date, edge). Returns rows + a provider report
// (sources / unavailable / dates) so the job can surface usage & partials.
import { EDGES } from "@/lib/edges/registry";
import { resolveCandles, resolveBenchmark, sliceAsOf } from "@/lib/edges/data";
import { crossSectionalZ } from "@/lib/edges/standardize";
import type { Candle } from "@/lib/data/technicals";
import type { Market } from "@/lib/edges/types";

const last = <T,>(a: T[]) => a[a.length - 1];

export interface EdgeSignalRow {
  symbol: string; date: string; edgeId: string; market: Market;
  raw: number; z: number | null; source: string;
}
export interface ProviderReport {
  market: Market;
  symbolsRequested: number;
  symbolsResolved: number;
  unavailable: string[];
  sources: Record<string, number>;
  benchmarkSource: string;
  dates: string[];
  rows: number;
}
export interface ComputeOutput { rows: EdgeSignalRow[]; report: ProviderReport }

export async function computeEdges(opts: {
  market: Market;
  symbols: string[];
  asOfDates?: string[];
  maxDays?: number;
}): Promise<ComputeOutput> {
  const { market, symbols } = opts;
  const bench = await resolveBenchmark(market);

  const resolved: { symbol: string; candles: Candle[]; source: string }[] = [];
  const unavailable: string[] = [];
  const sources: Record<string, number> = {};
  for (const sym of symbols) {
    const { candles, source } = await resolveCandles(sym, market);
    sources[source] = (sources[source] ?? 0) + 1;
    if (candles.length) resolved.push({ symbol: sym, candles, source });
    else unavailable.push(sym);
  }

  let dates: string[];
  if (opts.asOfDates && opts.asOfDates.length) {
    dates = opts.asOfDates.slice(0, opts.maxDays ?? 20);
  } else {
    const latest = bench.candles.length
      ? last(bench.candles).date
      : resolved.reduce((mx, r) => { const d = last(r.candles)?.date ?? ""; return d > mx ? d : mx; }, "");
    dates = latest ? [latest] : [];
  }

  const rows: EdgeSignalRow[] = [];
  for (const asOf of dates) {
    const benchAsOf = sliceAsOf(bench.candles, asOf);
    for (const edge of EDGES) {
      const cells: { symbol: string; raw: number; source: string }[] = [];
      for (const r of resolved) {
        const candlesAsOf = sliceAsOf(r.candles, asOf);
        if (candlesAsOf.length < edge.minCandles) continue;
        const raw = edge.compute({ symbol: r.symbol, market, asOf, candles: candlesAsOf, benchmark: benchAsOf });
        if (raw == null || !Number.isFinite(raw)) continue;
        cells.push({ symbol: r.symbol, raw, source: r.source });
      }
      if (cells.length < 2) continue; // need a cross-section to standardize
      const z = crossSectionalZ(cells.map(c => c.raw));
      cells.forEach((c, i) => {
        rows.push({ symbol: c.symbol, date: asOf, edgeId: edge.id, market, raw: c.raw, z: z[i], source: c.source });
      });
    }
  }

  return {
    rows,
    report: {
      market, symbolsRequested: symbols.length, symbolsResolved: resolved.length,
      unavailable, sources, benchmarkSource: bench.source, dates, rows: rows.length,
    },
  };
}
