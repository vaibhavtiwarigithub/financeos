import { NextRequest, NextResponse } from "next/server";
import { indiaScreenUniverse } from "@/lib/india-universe";
import { fetchIndiaOverview, fetchIndiaCandles } from "@/lib/india-data";
import { computeTechnicals } from "@/lib/data/technicals";
import { STRATEGY_MAP } from "@/lib/strategy-definitions";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// India Scanner — the free stand-in for a paid India screener.
//
// There is NO free India screen API, so we screen the ~NIFTY-100 universe
// (indiaScreenUniverse) name-by-name: pull Yahoo fundamentals (fetchIndiaOverview,
// AV-OVERVIEW-shaped) + daily candles (fetchIndiaCandles), compute RSI-14 / EMA-50
// locally, and apply the SAME filter conditions the US scanner UI exposes
// (RSI min/max, price vs 50-MA, plus a strategy's fundamental scan_filters).
//
// Prices are in ₹. Honestly capped at ~NIFTY-100 — the client surfaces that.
//
// Concurrency: Yahoo rate-limits, so we fetch in batches of 8 with a short
// pause between batches rather than firing ~100 requests at once.

const BATCH_SIZE = 8;
const BATCH_PAUSE_MS = 400;

interface ScanResult {
  symbol: string;
  rsi: number | null;
  price: number | null;
  ema50: number | null;
  price_above_ma50: boolean | null;
  fundamental_score: number | null;
  technical_score: number | null;
  combined_score: number | null;
  fundamentals: Record<string, any>;
  passes_filters: boolean;
  data_sufficient: boolean;
  filter_notes: string[];
}

// Score fundamentals from the AV-OVERVIEW-shaped India overview. Mirrors the
// US scanner's intent (P/E, ROE, revenue growth, margin) but reads the fields
// fetchIndiaOverview actually populates. Returns null when there's no usable
// fundamentals data (so we never fabricate a neutral 50).
function scoreIndiaFundamentals(ov: Record<string, string>): number | null {
  const has = (k: string) => ov[k] != null && ov[k] !== "";
  if (!has("PERatio") && !has("ReturnOnEquityTTM") && !has("QuarterlyRevenueGrowthYOY") && !has("ProfitMargin")) {
    return null;
  }
  const pe   = parseFloat(ov.PERatio ?? "0");
  const roe  = parseFloat(ov.ReturnOnEquityTTM ?? "0");        // Yahoo returns a fraction (0.18)
  const revG = parseFloat(ov.QuarterlyRevenueGrowthYOY ?? "0"); // fraction (0.12)
  const marg = parseFloat(ov.ProfitMargin ?? "0");             // fraction (0.15)

  let pts = 0;
  if (pe > 0 && pe < 20)   pts += 20;
  else if (pe > 0 && pe < 30) pts += 10;
  if (roe > 0.20)          pts += 25;
  else if (roe > 0.12)     pts += 15;
  if (revG > 0.20)         pts += 25;
  else if (revG > 0.08)    pts += 15;
  if (marg > 0.15)         pts += 15;
  else if (marg > 0.05)    pts += 8;
  return Math.min(95, 40 + pts);
}

// Apply a strategy's fundamental scan_filters (same definitions the US scanner
// uses) against the India overview, in the fields Yahoo gives us. Filters on
// fields we can't map are skipped (not failed) so we don't reject on missing data.
function applyStrategyFilters(
  filters: Array<{ field: string; operator: string; value: number }>,
  ov: Record<string, string>,
): { passes: boolean; notes: string[] } {
  const notes: string[] = [];
  let passes = true;
  const map: Record<string, number | null> = {
    pe_ratio: ov.PERatio != null ? parseFloat(ov.PERatio) : null,
    return_on_equity: ov.ReturnOnEquityTTM != null ? parseFloat(ov.ReturnOnEquityTTM) : null,
    revenue_growth: ov.QuarterlyRevenueGrowthYOY != null ? parseFloat(ov.QuarterlyRevenueGrowthYOY) : null,
    profit_margin: ov.ProfitMargin != null ? parseFloat(ov.ProfitMargin) : null,
  };
  for (const f of filters) {
    const v = map[f.field];
    if (v == null || Number.isNaN(v)) continue; // unmappable / missing → skip, don't fail
    const ok =
      f.operator === "gt" || f.operator === "gte" ? v >= f.value :
      f.operator === "lt" || f.operator === "lte" ? v <= f.value :
      f.operator === "eq" ? v === f.value : true;
    if (!ok) { passes = false; notes.push(`${f.field} ${v.toFixed(2)} fails ${f.operator} ${f.value}`); }
  }
  return { passes, notes };
}

// Read the nightly pre-scored full-NSE cache (india_screen_cache) and apply the
// same filters the live scan applies. Returns a scan-response payload, or null if
// the cache is empty / the table is missing (query error) — caller falls back to
// the live ~NIFTY-100 scan. Never throws.
async function scanFromCache(opts: {
  rsiMin?: number;
  rsiMax?: number;
  aboveMa50?: boolean;
  scanFilters: Array<{ field: string; operator: string; value: number }>;
  strategy: { id: string; name: string } | null | undefined;
  limit: number;
}): Promise<Record<string, any> | null> {
  try {
    const sb = createServiceClient();
    let q = sb.from("india_screen_cache").select("*");

    // Push what we can into SQL (RSI range, MA50). Fundamentals filters are applied
    // in JS below since strategy filters map onto several columns/operators.
    if (opts.rsiMin != null) q = q.gte("rsi", opts.rsiMin);
    if (opts.rsiMax != null) q = q.lte("rsi", opts.rsiMax);
    if (opts.aboveMa50 === true) q = q.eq("above_ma50", true);
    else if (opts.aboveMa50 === false) q = q.eq("above_ma50", false);

    const { data, error } = await q;
    if (error) return null;                    // missing table / query error → fall back
    if (!Array.isArray(data) || data.length === 0) return null; // empty cache → fall back

    // Map strategy fundamental filters onto cache columns.
    const colFor: Record<string, string> = {
      pe_ratio: "pe",
      return_on_equity: "roe",
      revenue_growth: "rev_growth",
      profit_margin: "profit_margin",
    };

    const scored = data.map((row: Record<string, any>) => {
      const filterNotes: string[] = [];
      let passes = true;
      let notEvaluated = false; // a requested condition referenced a field absent from this cache row

      const rsi: number | null = row.rsi != null && !Number.isNaN(Number(row.rsi)) ? Number(row.rsi) : null;
      const aboveMa50: boolean | null = row.above_ma50 ?? null;

      // Technical score (mirrors live scan)
      let techScore: number | null = null;
      if (rsi != null) {
        if (rsi > 60)      techScore = 75;
        else if (rsi < 40) techScore = 35;
        else               techScore = 50 + (rsi - 50) * 0.5;
      }

      // RSI range filters — if requested but this row has no RSI, abstain (don't silently pass).
      if (opts.rsiMin != null || opts.rsiMax != null) {
        if (rsi == null) {
          filterNotes.push("RSI unavailable — condition not evaluated"); notEvaluated = true;
        } else {
          if (opts.rsiMin != null && rsi < opts.rsiMin) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} < required ${opts.rsiMin}`); passes = false;
          }
          if (opts.rsiMax != null && rsi > opts.rsiMax) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} > max ${opts.rsiMax}`); passes = false;
          }
        }
      }

      // Price vs 50-day MA filter — abstain when the row lacks the flag.
      if (opts.aboveMa50 != null) {
        if (aboveMa50 == null) {
          filterNotes.push("Price/MA50 unavailable — condition not evaluated"); notEvaluated = true;
        } else if (opts.aboveMa50 === true && aboveMa50 === false) {
          filterNotes.push("Price below 50-day MA"); passes = false;
        } else if (opts.aboveMa50 === false && aboveMa50 === true) {
          filterNotes.push("Price above 50-day MA (need below)"); passes = false;
        }
      }

      // Fundamental score from the pre-scored cache columns (same thresholds as live)
      const ov: Record<string, string> = {};
      if (row.pe != null)            ov.PERatio = String(row.pe);
      if (row.roe != null)           ov.ReturnOnEquityTTM = String(row.roe);
      if (row.rev_growth != null)    ov.QuarterlyRevenueGrowthYOY = String(row.rev_growth);
      if (row.profit_margin != null) ov.ProfitMargin = String(row.profit_margin);
      if (row.sector != null)        ov.Sector = String(row.sector);
      const fundScore = scoreIndiaFundamentals(ov);

      // Strategy fundamental filters (applied in JS against cache columns). A filter on a
      // field that's null/missing in this row must ABSTAIN — never silently pass.
      for (const f of opts.scanFilters) {
        const col = colFor[f.field];
        if (!col) continue;                       // field the cache doesn't model → skip, don't fail
        const v = row[col];
        if (v == null || Number.isNaN(Number(v))) {
          filterNotes.push(`${f.field} unavailable — condition not evaluated`); notEvaluated = true; continue;
        }
        const num = Number(v);
        const ok =
          f.operator === "gt" || f.operator === "gte" ? num >= f.value :
          f.operator === "lt" || f.operator === "lte" ? num <= f.value :
          f.operator === "eq" ? num === f.value : true;
        if (!ok) { passes = false; filterNotes.push(`${f.field} ${num.toFixed(2)} fails ${f.operator} ${f.value}`); }
      }

      const combined =
        techScore != null && fundScore != null ? Math.round(fundScore * 0.5 + techScore * 0.5)
        : techScore != null ? Math.round(techScore)
        : fundScore != null ? Math.round(fundScore)
        : null;

      const dataSufficient = !notEvaluated;
      const passesFilters = passes && dataSufficient;
      if (passesFilters && filterNotes.length === 0) filterNotes.push("All conditions met");
      if (!dataSufficient && filterNotes.length === 0) filterNotes.push("Insufficient data to evaluate conditions");

      return {
        symbol: row.symbol,
        rsi: rsi != null ? parseFloat(rsi.toFixed(1)) : null,
        price: row.price,
        ema50: row.ema50,
        price_above_ma50: aboveMa50,
        fundamental_score: fundScore != null ? Math.round(fundScore) : null,
        technical_score: techScore != null ? Math.round(techScore) : null,
        combined_score: combined,
        fundamentals: ov,
        passes_filters: passesFilters,
        data_sufficient: dataSufficient,
        filter_notes: filterNotes,
      };
    });

    scored.sort((a: any, b: any) => {
      if (a.passes_filters && !b.passes_filters) return -1;
      if (!a.passes_filters && b.passes_filters) return 1;
      return (b.combined_score ?? -1) - (a.combined_score ?? -1);
    });

    // Oldest scored_at across the cache = how fresh the nightly pre-score is.
    let oldest: string | null = null;
    for (const row of data as Array<{ scored_at?: string }>) {
      if (row.scored_at && (oldest == null || row.scored_at < oldest)) oldest = row.scored_at;
    }

    return {
      strategy: opts.strategy ? { id: opts.strategy.id, name: opts.strategy.name } : null,
      market: "india",
      source: "nse_cache",
      cache_count: data.length,
      cache_oldest_scored_at: oldest,
      total_scanned: data.length,
      passing: scored.filter((r: any) => r.passes_filters).length,
      results: scored.slice(0, opts.limit),
      data_sources: {
        fundamentals: "Yahoo Finance (India, ₹) — nightly cache",
        technicals: "Yahoo candles → local RSI/EMA — nightly cache",
      },
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const {
      strategy_id,
      rsi_min,
      rsi_max,
      price_above_ma50,
      symbols: manualSymbols,
      limit = 20,
    } = body as {
      strategy_id?: string;
      rsi_min?: number;
      rsi_max?: number;
      price_above_ma50?: boolean;
      symbols?: string[];
      limit?: number;
    };

    const strategy = strategy_id ? STRATEGY_MAP[strategy_id] : null;
    const techConditions = strategy?.conditions?.technical ?? {};
    const scanFilters = strategy?.scan_filters ?? [];

    const effectiveRsiMin = rsi_min ?? techConditions.rsi_min;
    const effectiveRsiMax = rsi_max ?? techConditions.rsi_max;
    const effectiveMa50   = price_above_ma50 ?? techConditions.price_above_ma50;

    // Candidate universe: manual override (normalized to .NS) or the full ~NIFTY-100.
    let candidates: string[] = (manualSymbols ?? [])
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
      .map(s => (s.endsWith(".NS") || s.endsWith(".BO") ? s : `${s}.NS`));

    // Full-market path: with no manual symbol override, try the nightly pre-score
    // cache (india_screen_cache) — the whole NSE market, pre-scored. Filter it in
    // SQL where possible and return immediately. If the table is empty or missing
    // (query errors), fall through to the live ~NIFTY-100 scan below.
    if (!candidates.length) {
      const cached = await scanFromCache({
        rsiMin: effectiveRsiMin,
        rsiMax: effectiveRsiMax,
        aboveMa50: effectiveMa50,
        scanFilters,
        strategy,
        limit,
      });
      if (cached) return NextResponse.json(cached);
    }

    if (!candidates.length) candidates = indiaScreenUniverse();
    candidates = [...new Set(candidates)];

    const results: ScanResult[] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const batchOut = await Promise.all(batch.map(async (symbol): Promise<ScanResult> => {
        const [ov, candles] = await Promise.all([
          fetchIndiaOverview(symbol),
          fetchIndiaCandles(symbol, "6mo"),
        ]);

        const tech = computeTechnicals(candles);
        const rsi = tech.rsi14;
        const ema50 = tech.ema50;
        const price = candles.length ? candles[candles.length - 1].close : null;
        const priceAboveMa50 =
          tech.priceVsEma50 === "above" ? true : tech.priceVsEma50 === "below" ? false : null;

        const filterNotes: string[] = [];
        let passes = true;
        let notEvaluated = false;

        // Technical score + RSI filters (same logic as US scanner)
        let techScore: number | null = null;
        if (rsi != null) {
          if (rsi > 60)      techScore = 75;
          else if (rsi < 40) techScore = 35;
          else               techScore = 50 + (rsi - 50) * 0.5;
          if (effectiveRsiMin != null && rsi < effectiveRsiMin) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} < required ${effectiveRsiMin}`); passes = false;
          }
          if (effectiveRsiMax != null && rsi > effectiveRsiMax) {
            filterNotes.push(`RSI ${rsi.toFixed(0)} > max ${effectiveRsiMax}`); passes = false;
          }
        } else if (effectiveRsiMin != null || effectiveRsiMax != null) {
          filterNotes.push("RSI unavailable — condition not evaluated"); notEvaluated = true;
        }

        // Price vs 50-day MA filter
        if (effectiveMa50 === true && priceAboveMa50 === false) {
          filterNotes.push("Price below 50-day MA"); passes = false;
        } else if (effectiveMa50 === false && priceAboveMa50 === true) {
          filterNotes.push("Price above 50-day MA (need below)"); passes = false;
        } else if (effectiveMa50 != null && priceAboveMa50 === null) {
          filterNotes.push("Price/MA50 unavailable — condition not evaluated"); notEvaluated = true;
        }

        // Fundamental score + strategy fundamental filters (₹, Yahoo fields)
        const fundScore = scoreIndiaFundamentals(ov);
        if (scanFilters.length) {
          const { passes: fPass, notes: fNotes } = applyStrategyFilters(scanFilters, ov);
          if (!fPass) passes = false;
          filterNotes.push(...fNotes);
        }

        const combined =
          techScore != null && fundScore != null ? Math.round(fundScore * 0.5 + techScore * 0.5)
          : techScore != null ? Math.round(techScore)
          : fundScore != null ? Math.round(fundScore)
          : null;

        const dataSufficient = !notEvaluated;
        const passesFilters = passes && dataSufficient;
        if (passesFilters && filterNotes.length === 0) filterNotes.push("All conditions met");
        if (!dataSufficient && filterNotes.length === 0) filterNotes.push("Insufficient data to evaluate conditions");

        return {
          symbol,
          rsi: rsi != null ? parseFloat(rsi.toFixed(1)) : null,
          price,
          ema50,
          price_above_ma50: priceAboveMa50,
          fundamental_score: fundScore != null ? Math.round(fundScore) : null,
          technical_score: techScore != null ? Math.round(techScore) : null,
          combined_score: combined,
          fundamentals: ov,
          passes_filters: passesFilters,
          data_sufficient: dataSufficient,
          filter_notes: filterNotes,
        };
      }));
      results.push(...batchOut);
      if (i + BATCH_SIZE < candidates.length) await new Promise(r => setTimeout(r, BATCH_PAUSE_MS));
    }

    results.sort((a, b) => {
      if (a.passes_filters && !b.passes_filters) return -1;
      if (!a.passes_filters && b.passes_filters) return 1;
      return (b.combined_score ?? -1) - (a.combined_score ?? -1);
    });

    return NextResponse.json({
      strategy: strategy ? { id: strategy.id, name: strategy.name } : null,
      market: "india",
      source: "live_nifty100",
      total_scanned: candidates.length,
      passing: results.filter(r => r.passes_filters).length,
      results: results.slice(0, limit),
      data_sources: {
        fundamentals: "Yahoo Finance (India, ₹)",
        technicals: "Yahoo candles → local RSI/EMA",
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
