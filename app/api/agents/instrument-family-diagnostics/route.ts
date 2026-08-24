import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { buildInstrumentFamilyDiagnostics, INSTRUMENT_DIAGNOSTIC_VERSION, type FamilyDiagnosticRow } from "@/lib/scoring/instrument-family-diagnostics";

export const dynamic = "force-dynamic";

type Market = "us" | "india";

async function labelsByObservation(svc: any, ids: number[]) {
  const labels = new Map<number, Partial<Record<5 | 10 | 20, number | null>>>();
  for (let index = 0; index < ids.length; index += 500) {
    const { data, error } = await svc.from("observation_labels")
      .select("observation_id,horizon_days,benchmark_neutral_return")
      .in("observation_id", ids.slice(index, index + 500))
      .in("horizon_days", [5, 10, 20]);
    if (error) throw new Error(`label query failed: ${error.message}`);
    for (const row of data ?? []) {
      const horizon = Number((row as any).horizon_days) as 5 | 10 | 20;
      labels.set(Number((row as any).observation_id), {
        ...(labels.get(Number((row as any).observation_id)) ?? {}),
        [horizon]: (row as any).benchmark_neutral_return == null ? null : Number((row as any).benchmark_neutral_return),
      });
    }
  }
  return labels;
}

export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const requested = new URL(request.url).searchParams.get("market");
  if (requested && requested !== "us" && requested !== "india") {
    return NextResponse.json({ error: "market must be us or india" }, { status: 400 });
  }
  const market = requested as Market | null;
  const svc = createServiceClient();
  let query = svc.from("instrument_family_observations")
    .select("observation_id,market,symbol,instrument_family,exposure_id,decision_observations!inner(id,ts,analyst_score)")
    .order("created_at", { ascending: false }).limit(10000);
  if (market) query = query.eq("market", market);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ids = (data ?? []).map((row: any) => Number(row.observation_id)).filter(Number.isFinite);
  const labels = await labelsByObservation(svc, ids);
  const rows: FamilyDiagnosticRow[] = (data ?? []).flatMap((row: any) => {
    const decision = Array.isArray(row.decision_observations) ? row.decision_observations[0] : row.decision_observations;
    if (!decision?.ts) return [];
    const id = Number(row.observation_id);
    return [{
      observationId: id,
      market: row.market,
      symbol: String(row.symbol),
      family: String(row.instrument_family),
      exposureId: String(row.exposure_id),
      ts: String(decision.ts),
      score: decision.analyst_score == null ? null : Number(decision.analyst_score),
      labels: labels.get(id) ?? {},
    }];
  });
  return NextResponse.json({
    version: INSTRUMENT_DIAGNOSTIC_VERSION,
    market: market ?? "all",
    generatedAt: new Date().toISOString(),
    reports: buildInstrumentFamilyDiagnostics(rows),
    influence: "None. Read-only measurement; no score, eligibility, sizing, paper, live, exit or broker path consumes this output.",
  });
}
