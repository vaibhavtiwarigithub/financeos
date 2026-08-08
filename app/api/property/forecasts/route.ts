import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { buildPropertyBaselineForecast } from "@/lib/property/forecast";
import { PROPERTY_MARKETS } from "@/lib/property/registry";

export const dynamic = "force-dynamic";

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
    .select("id, geography_slug, metric_key, horizon_days, cutoff_at, lower_value, base_value, upper_value, model_version, state, created_at")
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
    const { data } = await svc.from("property_market_observations").select("as_of, value").eq("geography_slug", market.id).eq("metric_key", metric).order("as_of", { ascending: true }).limit(100);
    const forecast = buildPropertyBaselineForecast((data ?? []).map((row: any) => ({ asOf: row.as_of, value: Number(row.value) })));
    if (!forecast) continue;
    const latestDate = data![data!.length - 1].as_of; const horizonDays = metric === "mortgage_rate" ? 90 : 365;
    const { data: existing } = await svc.from("property_forecasts").select("id").eq("geography_slug", market.id).eq("metric_key", metric).eq("cutoff_at", `${latestDate}T23:59:59.000Z`).eq("model_version", forecast.method).maybeSingle();
    if (existing) continue;
    const { data: row, error } = await svc.from("property_forecasts").insert({ geography_slug: market.id, metric_key: metric, horizon_days: horizonDays, cutoff_at: `${latestDate}T23:59:59.000Z`, lower_value: forecast.lower, base_value: forecast.base, upper_value: forecast.upper, model_version: forecast.method, state: "shadow" }).select("id, geography_slug, metric_key").single();
    if (!error && row) created.push(row);
  }
  const { data: pending } = await svc.from("property_forecasts").select("id, geography_slug, metric_key, cutoff_at, horizon_days, lower_value, base_value, upper_value").eq("state", "shadow");
  for (const forecast of pending ?? []) {
    const maturity = new Date(new Date(forecast.cutoff_at).getTime() + Number(forecast.horizon_days) * 86_400_000).toISOString().slice(0, 10);
    if (maturity > new Date().toISOString().slice(0, 10)) continue;
    const { data: already } = await svc.from("property_forecast_outcomes").select("id").eq("forecast_id", forecast.id).maybeSingle(); if (already) continue;
    const { data: actual } = await svc.from("property_market_observations").select("value, as_of").eq("geography_slug", forecast.geography_slug).eq("metric_key", forecast.metric_key).gte("as_of", maturity).order("as_of", { ascending: true }).limit(1).maybeSingle();
    if (!actual) continue;
    const value = Number(actual.value); const base = Number(forecast.base_value); const lower = Number(forecast.lower_value); const upper = Number(forecast.upper_value);
    const { data: outcome, error } = await svc.from("property_forecast_outcomes").insert({ forecast_id: forecast.id, actual_value: value, absolute_error: Math.abs(value - base), interval_covered: value >= lower && value <= upper }).select("id, forecast_id").single();
    if (!error && outcome) matured.push(outcome);
  }
  return NextResponse.json({ ok: true, created, matured });
}
