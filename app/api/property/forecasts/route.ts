import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import {
  buildPropertyBaselineForecast,
  inferPeriodsForward,
  selectForecastObservationWindow,
} from "@/lib/property/forecast";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";
const FORECAST_INPUT_QUERY_LIMIT = 500;
const FORECAST_INPUT_POINT_LIMIT = 100;

/**
 * Read persisted shadow forecasts together with any matured outcome.
 *
 * The route was POST-only, so the Forecasts workspace had no way to display the
 * ledger it exists to show. Outcomes are fetched separately and joined in
 * memory rather than via an embedded PostgREST relation: `property_forecasts`
 * has no FK POINTING AT it that PostgREST would expose in that direction, and a
 * missing outcome is the normal case (a forecast is unmatured until its horizon
 * elapses), so an inner join would silently hide most of the ledger.
 */
export async function GET() {
  const gate = await requireOwner(); if (gate) return gate;
  const svc = createServiceClient();

  const { data: forecasts, error } = await svc.from("property_forecasts")
    .select("id, geography_slug, source_key, metric_key, horizon_days, cutoff_at, lower_value, base_value, upper_value, model_version, state, created_at")
    .order("cutoff_at", { ascending: false })
    .limit(500);
  if (error) return NextResponse.json({ error: "Forecast ledger is temporarily unavailable" }, { status: 503 });

  const ids = (forecasts ?? []).map((f: any) => f.id);
  let outcomes: any[] = [];
  if (ids.length) {
    const { data, error: outcomeError } = await svc.from("property_forecast_outcomes")
      .select("forecast_id, actual_value, evaluated_at, absolute_error, interval_covered")
      .in("forecast_id", ids);
    // A failed outcome read must not be reported as "nothing has matured yet".
    if (outcomeError) return NextResponse.json({ error: "Forecast outcomes are temporarily unavailable" }, { status: 503 });
    outcomes = data ?? [];
  }
  const byForecast = new Map(outcomes.map((o: any) => [o.forecast_id, o]));

  return NextResponse.json({
    forecasts: (forecasts ?? []).map((f: any) => ({ ...f, outcome: byForecast.get(f.id) ?? null })),
    maturedCount: outcomes.length,
  });
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) { const gate = await requireOwner(); if (gate) return gate; }
  const svc = createServiceClient(); const created: unknown[] = []; const matured: unknown[] = [];
  for (const market of PROPERTY_MARKETS) for (const metric of ["price_index", "rent_index", "mortgage_rate"] as const) {
    // Fetch newest-first before limiting. The prior ascending query permanently
    // forecast from the oldest 100 rows once a series exceeded that bound.
    const { data, error: observationError } = await svc.from("property_market_observations")
      .select("source_key, as_of, value, collected_at, revision_state")
      .eq("geography_slug", market.id)
      .eq("metric_key", metric)
      .order("as_of", { ascending: false })
      .order("collected_at", { ascending: false })
      .limit(FORECAST_INPUT_QUERY_LIMIT);
    if (observationError) {
      return NextResponse.json({ error: "Forecast inputs are temporarily unavailable" }, { status: 503 });
    }
    const selected = selectForecastObservationWindow((data ?? []).map((row: any) => ({
      sourceKey: String(row.source_key),
      asOf: String(row.as_of),
      value: Number(row.value),
      collectedAt: String(row.collected_at),
      revisionState: row.revision_state === "revised" ? "revised" as const : "initial" as const,
    })), FORECAST_INPUT_POINT_LIMIT);
    if (!selected) continue;
    const horizonDays = metric === "mortgage_rate" ? 90 : 365;
    const periodsForward = inferPeriodsForward(selected.points, horizonDays);
    if (!periodsForward) continue;
    const forecast = buildPropertyBaselineForecast(selected.points, periodsForward);
    if (!forecast) continue;
    const latestDate = selected.points[selected.points.length - 1].asOf;
    const modelVersion = `${forecast.method}:${selected.sourceKey}`;
    const { data: existing, error: existingError } = await svc.from("property_forecasts").select("id").eq("geography_slug", market.id).eq("metric_key", metric).eq("horizon_days", horizonDays).eq("cutoff_at", `${latestDate}T23:59:59.000Z`).eq("model_version", modelVersion).maybeSingle();
    if (existingError) return NextResponse.json({ error: "Forecast ledger is temporarily unavailable" }, { status: 503 });
    if (existing) continue;
    const { data: row, error } = await svc.from("property_forecasts").insert({ geography_slug: market.id, source_key: selected.sourceKey, metric_key: metric, horizon_days: horizonDays, cutoff_at: `${latestDate}T23:59:59.000Z`, lower_value: forecast.lower, base_value: forecast.base, upper_value: forecast.upper, model_version: modelVersion, state: "shadow" }).select("id, geography_slug, metric_key").single();
    // A concurrent invocation may win the unique identity insert. That is an
    // idempotent no-op; every other insert failure is operationally visible.
    if (error && error.code !== "23505") return NextResponse.json({ error: "Forecast could not be recorded" }, { status: 503 });
    if (row) created.push(row);
  }
  const { data: pending, error: pendingError } = await svc.from("property_forecasts")
    .select("id, geography_slug, source_key, metric_key, cutoff_at, horizon_days, lower_value, base_value, upper_value")
    .eq("state", "shadow")
    .order("cutoff_at", { ascending: true })
    .limit(500);
  if (pendingError) return NextResponse.json({ error: "Pending forecasts are temporarily unavailable" }, { status: 503 });
  for (const forecast of pending ?? []) {
    const maturity = new Date(new Date(forecast.cutoff_at).getTime() + Number(forecast.horizon_days) * 86_400_000).toISOString().slice(0, 10);
    if (maturity > new Date().toISOString().slice(0, 10)) continue;
    const { data: already, error: alreadyError } = await svc.from("property_forecast_outcomes").select("id").eq("forecast_id", forecast.id).maybeSingle();
    if (alreadyError) return NextResponse.json({ error: "Forecast outcomes are temporarily unavailable" }, { status: 503 });
    if (already) continue;
    // The nearest observation on/after maturity is the realized horizon. For a
    // same-date revision set, freeze the earliest collected row so calibration
    // cannot look ahead to a later revision.
    let actualQuery = svc.from("property_market_observations")
      .select("id, value, as_of, collected_at")
      .eq("geography_slug", forecast.geography_slug)
      .eq("metric_key", forecast.metric_key)
      .gte("as_of", maturity);
    // Historical v1 forecasts predate source provenance. Keep them scoreable
    // under the then-single-source contract; every v2 forecast is source-bound.
    if (forecast.source_key) actualQuery = actualQuery.eq("source_key", forecast.source_key);
    const { data: actual, error: actualError } = await actualQuery
      .order("as_of", { ascending: true })
      .order("collected_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (actualError) return NextResponse.json({ error: "Matured observations are temporarily unavailable" }, { status: 503 });
    if (!actual) continue;
    const value = Number(actual.value); const base = Number(forecast.base_value); const lower = Number(forecast.lower_value); const upper = Number(forecast.upper_value);
    if (![value, base, lower, upper].every(Number.isFinite)) {
      return NextResponse.json({ error: "Forecast or outcome contains an invalid numeric value" }, { status: 503 });
    }
    const { data: outcome, error } = await svc.from("property_forecast_outcomes").insert({ forecast_id: forecast.id, actual_observation_id: actual.id, actual_value: value, absolute_error: Math.abs(value - base), interval_covered: value >= lower && value <= upper }).select("id, forecast_id").single();
    if (error && error.code !== "23505") return NextResponse.json({ error: "Forecast outcome could not be recorded" }, { status: 503 });
    if (outcome) matured.push(outcome);
  }
  return NextResponse.json({ ok: true, created, matured });
}
