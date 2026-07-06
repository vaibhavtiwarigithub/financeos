import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Research Journal — Evolution tab: longer-horizon trend of how the learning
// loop is (or isn't yet) improving. Honest about thin history — never draws
// a trend from 1-2 points, just states the count plainly.
export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const market = url.searchParams.get("market") === "india" ? "india" : "us";
  const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get("days") ?? "90")));
  const since = new Date(Date.now() - days * 86400_000).toISOString();

  const svc = createServiceClient();
  const [{ data: learnerRuns }, { data: featureHistory }, { data: calibration }, { data: shadowDecisions }] = await Promise.all([
    svc.from("learner_runs").select("run_date, weight_mutations, weights_changed, win_rate_snapshot, hypotheses, created_at").gte("created_at", since).order("created_at", { ascending: true }),
    svc.from("feature_registry_history").select("*").gte("created_at", since).order("created_at", { ascending: true }),
    svc.from("model_artifacts").select("kind, calibration, n_observations, fitted_at").eq("market", market).gte("fitted_at", since).order("fitted_at", { ascending: true }),
    svc.from("shadow_decisions").select("would_enter, score, ts").eq("market", market).gte("ts", since),
  ]);

  const learnerRunsArr = (learnerRuns ?? []) as any[];
  const weightSeries = learnerRunsArr
    .filter(r => r.weight_mutations || r.weights_changed)
    .map(r => ({ date: r.run_date ?? r.created_at?.slice(0, 10), mutations: r.weight_mutations ?? r.weights_changed, win_rate: r.win_rate_snapshot }));

  const featureTimeline = (featureHistory ?? []).map((f: any) => ({ date: f.created_at, feature_id: f.feature_id, from: f.from_status, to: f.to_status, reason: f.reason }));

  const calibrationSeries = (calibration ?? []).map((c: any) => ({ date: c.fitted_at, n_observations: c.n_observations, brier: (c.calibration as any)?.brier_score ?? null }));

  const shadowArr = (shadowDecisions ?? []) as any[];
  const shadowAgreementPct = shadowArr.length > 0
    ? Math.round((shadowArr.filter((s: any) => s.would_enter).length / shadowArr.length) * 100)
    : null;

  return NextResponse.json({
    market, days,
    learner: { runsCount: learnerRunsArr.length, weightSeries, enoughHistory: learnerRunsArr.length >= 3 },
    featureRegistry: { events: featureTimeline, enoughHistory: featureTimeline.length >= 3 },
    calibration: { series: calibrationSeries, enoughHistory: calibrationSeries.length >= 3 },
    shadow: { decisionsCount: shadowArr.length, agreementPct: shadowAgreementPct, enoughHistory: shadowArr.length >= 10 },
  });
}
