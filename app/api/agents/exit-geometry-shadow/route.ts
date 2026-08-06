import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import {
  CANDIDATE_GEOMETRIES,
  evaluateGeometry,
  geometryLabel,
  isBaseline,
  MAX_AMBIGUOUS_SHARE,
  type LabelPoint,
} from "@/lib/trading/exit-geometry-shadow";
import { coverageByHorizon, MIN_DISTINCT_DATES, type LabelRow } from "@/lib/shadows/label-coverage";

export const dynamic = "force-dynamic";

// Exit-geometry shadow report — READ-ONLY COUNTERFACTUAL.
//
// Changes no stop, target, time stop, order or exit. Writes nothing: the result
// is derived entirely from `observation_labels`, so there is no new table and no
// state to keep in sync. Re-run it whenever more labels mature.
//
// See features/portfolio-underperformance/DIAGNOSIS.md §12. The configured
// +19.2% target is beyond the p90 favourable excursion of the 10-day holding
// window the time stop enforces, so it is unreachable by construction. But
// shortening it alone drops reward:risk below 1 and makes expectancy worse,
// which is why this measures before anything moves.

// The horizon the time stop actually enforces. Overridable via ?horizon= so a
// thin cohort can be cross-checked against a better-covered one: the 10-day US
// cohort spans only 2 dates, while 5-day spans 9. A conclusion that holds at one
// horizon and not the other is a coverage artefact, not a finding.
const DEFAULT_HORIZON_DAYS = 10;
const ALLOWED_HORIZONS = [2, 5, 10, 20];

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const url = new URL(req.url);
  const marketFilter = url.searchParams.get("market");
  const requested = Number(url.searchParams.get("horizon"));
  const HORIZON_DAYS = ALLOWED_HORIZONS.includes(requested) ? requested : DEFAULT_HORIZON_DAYS;
  const svc = createServiceClient();

  const { data, error } = await svc
    .from("observation_labels")
    .select("horizon_days,max_favorable_excursion,max_adverse_excursion,fwd_return,entry_atr_pct,decision_observations!inner(ts,symbol,market,entry_eligible)")
    .eq("horizon_days", HORIZON_DAYS)
    .limit(20000);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const byMarket = new Map<string, { points: LabelPoint[]; rows: LabelRow[] }>();
  for (const row of (data ?? []) as any[]) {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!decision) continue;
    // Only decisions that were actually eligible to become positions. A cohort
    // that never passed the eligibility gate cannot inform an exit rule — the
    // error that invalidated the first version of the diagnosis.
    if (decision.entry_eligible !== true) continue;
    if (marketFilter && decision.market !== marketFilter) continue;
    if (row.max_favorable_excursion == null || row.max_adverse_excursion == null) continue;
    // A missing ATR is kept, NOT filtered. Percentage geometries evaluate fine
    // without it, and dropping these rows starved the US arm to n=1 because
    // entry_atr_pct coverage at the 10-day horizon is 4.1%. ATR geometries
    // classify these as ambiguous, which is visible in the ambiguous share.
    const atrPct = Number(row.entry_atr_pct);

    const bucket = byMarket.get(decision.market) ?? { points: [], rows: [] };
    bucket.points.push({
      mfe: Number(row.max_favorable_excursion),
      mae: Number(row.max_adverse_excursion),
      fwd: Number(row.fwd_return),
      atrPct: Number.isFinite(atrPct) && atrPct > 0 ? atrPct : 0,
    });
    bucket.rows.push({
      date: String(decision.ts).slice(0, 10),
      symbol: String(decision.symbol ?? ""),
      horizonDays: HORIZON_DAYS,
      entryEligible: true,
    });
    byMarket.set(decision.market, bucket);
  }

  const markets: any[] = [];
  for (const [market, { points, rows }] of byMarket) {
    const coverage = coverageByHorizon(rows)[0];
    const atrCoverage = points.length ? points.filter((p) => p.atrPct > 0).length / points.length : 0;
    const results = CANDIDATE_GEOMETRIES.map((geometry) => ({
      ...evaluateGeometry(points, geometry),
      label: geometryLabel(geometry),
      mode: geometry.stopPct != null ? "percent" : "atr",
      baseline: isBaseline(geometry),
    }));
    const baseline = results.find((r) => r.baseline) ?? null;

    markets.push({
      market,
      coverage: {
        observations: coverage?.observations ?? 0,
        distinctDates: coverage?.distinctDates ?? 0,
        distinctSymbols: coverage?.distinctSymbols ?? 0,
        minDistinctDates: MIN_DISTINCT_DATES,
        sufficient: coverage?.sufficient ?? false,
        // ATR geometries can only be evaluated where entry_atr_pct exists.
        atrCoverage,
      },
      baseline,
      results,
      // US and India are reported separately and never pooled: different
      // benchmarks, sessions and currency.
      note: coverage?.sufficient
        ? "Coverage clears the date floor. Differences may be compared, still subject to overlap and multiple-testing caveats across the candidate grid."
        : `Only ${coverage?.distinctDates ?? 0} distinct decision date(s), below the floor of ${MIN_DISTINCT_DATES}. These numbers describe one regime and MUST NOT justify a geometry change.`,
    });
  }

  return NextResponse.json({
    horizonDays: HORIZON_DAYS,
    allowedHorizons: ALLOWED_HORIZONS,
    maxAmbiguousShare: MAX_AMBIGUOUS_SHARE,
    markets: markets.sort((a, b) => a.market.localeCompare(b.market)),
    method: "Counterfactual over matured labels. A decision whose window touched BOTH the candidate target and the candidate stop is classified ambiguous and excluded from the mean, because max-excursion statistics cannot recover which came first. Geometry is in ATR multiples, scaled by each decision's own entry ATR.",
    influence: "None. This endpoint changes no stop, target, time stop, order or exit, and writes nothing.",
  });
}
