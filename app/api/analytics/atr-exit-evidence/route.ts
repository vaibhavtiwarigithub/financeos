import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  ATR_EXIT_POLICY_VERSION,
  aggregateAtrExitEvidence,
  type AtrExitOutcome,
} from "@/lib/learning/atr-exit-evidence";

export const dynamic = "force-dynamic";

const ALLOWED_HORIZONS = new Set([2, 5, 10, 20]);

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const market = params.get("market") === "india" ? "india" : "us";
  const requestedHorizon = Number(params.get("horizon") ?? 10);
  const horizonDays = ALLOWED_HORIZONS.has(requestedHorizon) ? requestedHorizon : 10;
  const svc = createServiceClient();

  const { data: observations, error: observationError } = await svc
    .from("decision_observations")
    .select("id")
    .eq("market", market)
    .eq("entry_eligible", true)
    .eq("direction", "long")
    .order("ts", { ascending: true })
    .limit(5000);
  if (observationError) {
    return NextResponse.json({ error: "Unable to load ATR evidence cohort" }, { status: 500 });
  }

  const ids = (observations ?? []).map((row: { id: number }) => row.id);
  const labels: Array<{ fwd_return: number | null; atr_exit_outcomes: unknown }> = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const { data, error } = await svc
      .from("observation_labels")
      .select("fwd_return, atr_exit_outcomes")
      .eq("horizon_days", horizonDays)
      .eq("atr_policy_version", ATR_EXIT_POLICY_VERSION)
      .in("observation_id", ids.slice(offset, offset + 500));
    if (error) {
      return NextResponse.json({ error: "Unable to load matured ATR labels" }, { status: 500 });
    }
    labels.push(...(data ?? []));
  }

  const rows = labels.flatMap(label => {
    const horizonReturn = Number(label.fwd_return);
    if (!Number.isFinite(horizonReturn) || !Array.isArray(label.atr_exit_outcomes)) return [];
    return [{
      horizonReturn,
      outcomes: label.atr_exit_outcomes as AtrExitOutcome[],
    }];
  });

  return NextResponse.json({
    success: true,
    measureOnly: true,
    market,
    horizonDays,
    policyVersion: ATR_EXIT_POLICY_VERSION,
    eligibleObservations: ids.length,
    atrLabeledObservations: rows.length,
    coverage: ids.length ? rows.length / ids.length : 0,
    policies: aggregateAtrExitEvidence(rows, horizonDays),
  });
}
