import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { canonicalSectorKey, GICS_SECTORS } from "@/lib/scoring/sector-taxonomy";
import {
  sectorRelativeStrength, measureSectorSignal, MIN_SECTORS_PER_SESSION,
  type Bar, type SectorScoredRow,
} from "@/lib/learning/sector-regime";
import { quantileDiagnostics } from "@/lib/learning/factor-quantiles";
import { isEligibleLong } from "@/lib/learning/entry-cohort";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─────────────────────────────────────────────────────────────────────────────
// Sector-regime dimension — Stage 1, MEASURE ONLY.
// features/sector-regime-dimension/FEATURE_ARCHITECTURE.md
//
// Scores each decision by its SECTOR's trailing relative strength versus the
// market, then runs that through the same diagnostics as every other dimension:
// rank IC, quantile gradient, spread with nEffective, rank autocorrelation.
//
// It writes nothing. No score, sizing, entry, exit or broker path reads it. A
// promotion would be a separate governed decision on evidence clearing the
// pre-declared floors, and today's sample cannot clear them.
// ─────────────────────────────────────────────────────────────────────────────

/** GICS sector -> the SPDR sector ETF used as its price proxy. */
const SECTOR_ETF: Record<string, string> = {
  "Information Technology": "XLK",
  "Financials": "XLF",
  "Energy": "XLE",
  "Health Care": "XLV",
  "Industrials": "XLI",
  "Consumer Discretionary": "XLY",
  "Communication Services": "XLC",
  "Consumer Staples": "XLP",
  "Utilities": "XLU",
  "Real Estate": "XLRE",
  "Materials": "XLB",
};

const BENCHMARK = "SPY";
/** Trailing window for relative strength, in sessions. */
const RS_LOOKBACK = 20;

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const url = new URL(request.url);
  const horizonDays = Number(url.searchParams.get("horizon") ?? 5);

  try {
    const svc = createServiceClient();

    // Labelled US decisions with their technical score, paginated: a truncated
    // read would silently shrink the cross-section and change every percentile.
    const PAGE = 1000;
    const observations: any[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await svc
        .from("observation_labels")
        .select("observation_id,benchmark_neutral_return,horizon_days,decision_observations!inner(symbol,ts,market,entry_eligible,direction,technical_score)")
        .eq("horizon_days", horizonDays)
        .eq("decision_observations.market", "us")
        .not("benchmark_neutral_return", "is", null)
        .order("observation_id", { ascending: true })
        .range(offset, offset + PAGE - 1);
      if (error) throw new Error(`labels query failed: ${error.message}`);
      const page = data ?? [];
      observations.push(...page);
      if (page.length < PAGE) break;
    }

    const symbols = [...new Set(observations.map((row) => {
      const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      return String(decision?.symbol ?? "").toUpperCase();
    }).filter(Boolean))];

    const { data: profileRows } = await svc.from("symbol_profiles").select("symbol,sector").in("symbol", symbols);
    const sectorOf = new Map<string, string>();
    for (const row of profileRows ?? []) {
      const canonical = canonicalSectorKey((row as any).sector);
      // Only GICS equity sectors have an ETF proxy; fund classes and unmapped
      // labels are excluded rather than approximated.
      if (canonical && SECTOR_ETF[canonical]) sectorOf.set(String((row as any).symbol).toUpperCase(), canonical);
    }

    const etfSymbols = [...new Set([...Object.values(SECTOR_ETF), BENCHMARK])];
    const { data: barRows } = await svc.from("price_cache")
      .select("symbol,date,close").in("symbol", etfSymbols).order("date", { ascending: true }).limit(20000);
    const barsBySymbol = new Map<string, Bar[]>();
    for (const row of barRows ?? []) {
      const symbol = String((row as any).symbol).toUpperCase();
      const list = barsBySymbol.get(symbol) ?? [];
      list.push({ date: String((row as any).date).slice(0, 10), close: Number((row as any).close) });
      barsBySymbol.set(symbol, list);
    }
    const benchmarkBars = barsBySymbol.get(BENCHMARK) ?? [];

    // Relative strength is per (sector, session) — cache it rather than
    // recomputing per symbol.
    const rsCache = new Map<string, number | null>();
    const relativeStrength = (sector: string, session: string): number | null => {
      const key = `${sector}::${session}`;
      if (rsCache.has(key)) return rsCache.get(key)!;
      const value = sectorRelativeStrength(barsBySymbol.get(SECTOR_ETF[sector]) ?? [], benchmarkBars, session, RS_LOOKBACK);
      rsCache.set(key, value);
      return value;
    };

    const eligible: SectorScoredRow[] = [];
    let missingSector = 0;
    let missingRs = 0;
    const seen = new Set<string>();

    for (const row of observations) {
      const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
      if (!decision?.symbol || !decision.ts) continue;
      if (!isEligibleLong(decision.entry_eligible, decision.direction)) continue;
      const symbol = String(decision.symbol).toUpperCase();
      const session = String(decision.ts).slice(0, 10);
      // One row per (symbol, session): research writes 2-3x daily.
      const dedupe = `${symbol}::${session}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const sector = sectorOf.get(symbol);
      if (!sector) { missingSector++; continue; }
      const value = relativeStrength(sector, session);
      if (value == null) { missingRs++; continue; }

      eligible.push({
        symbol, session, sector, value,
        outcome: Number(row.benchmark_neutral_return),
        technical: decision.technical_score == null ? null : Number(decision.technical_score),
      });
    }

    const breadth = measureSectorSignal(eligible);
    const nEffective = breadth.qualifyingSessions / Math.max(1, horizonDays);
    const quantiles = quantileDiagnostics(
      eligible.map((r) => ({ symbol: r.symbol, value: r.value, outcome: r.outcome, ts: r.session })),
      { nEffective },
    );

    return NextResponse.json({
      market: "us",
      horizonDays,
      stage: "stage_1_measure_only",
      feature: "features/sector-regime-dimension/FEATURE_ARCHITECTURE.md",
      inputs: {
        labelled_observations: observations.length,
        eligible_long_scored: eligible.length,
        dropped_no_sector: missingSector,
        dropped_no_relative_strength: missingRs,
        sectors_available: [...new Set(eligible.map((r) => r.sector))].sort(),
        rs_lookback_sessions: RS_LOOKBACK,
        benchmark: BENCHMARK,
      },
      breadth,
      quantiles,
      nEffective,
      interpretation: {
        headline:
          "meanIcOverSectors is the defensible number. meanIcOverNames treats every name in a sector as an independent observation when they all carry the SAME value, so it overstates precision — the same error shape as a naive t of 3.09 against an overlap-corrected 1.38.",
        breadth:
          `A sector signal has at most one distinct value per sector. Effective cross-sectional breadth is the sector count (median ${breadth.medianSectorsPerSession}), not the name count (median ${breadth.medianNamesPerSession}). Sessions with fewer than ${MIN_SECTORS_PER_SESSION} sectors are excluded.`,
        technical_overlap:
          "Sector relative strength IS a momentum measure and technical currently ranks backwards at every horizon. A high correlation here means this is technical in slow motion, which is a reason to stop rather than a detail.",
        regime:
          "NOT conditioned on regime. Over the labelled window macro_regime holds essentially two states (yellow ~5 weeks, orange ~3), so a regime interaction is not estimable and fitting one would be curve-fitting to a single episode.",
        verdict:
          "Measure-only. No floor is claimed to be met; promotion requires a separate governed decision.",
      },
      influence: "None. Nothing writes; no scoring, sizing, exit, order or broker path reads this route.",
      coverage_note: `${GICS_SECTORS.length} GICS sectors exist; only those with an ETF proxy and a qualifying cross-section contribute.`,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "sector regime shadow failed" },
      { status: 500 },
    );
  }
}

// kairos_call_agent (the pg_cron -> Vercel bridge) issues net.http_post for
// every call regardless of the `method` argument it is given, so a GET-only
// route answers 405 to scheduled and service invocations. Same work, same
// read-only guarantees.
export async function POST(request: NextRequest) {
  return GET(request);
}
