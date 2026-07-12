import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Check = { key: string; pass: boolean; requiredFor: "engineering" | "autonomous"; detail: string };

async function authorize(req: NextRequest) {
  if (verifyCronSecret(req)) return true;
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  return Boolean(user);
}

function hoursSince(value: string | null | undefined): number {
  if (!value) return Infinity;
  return (Date.now() - new Date(value).getTime()) / 3_600_000;
}

async function runReadiness() {
  const svc = createServiceClient();
  const weekend = [0, 6].includes(new Date().getUTCDay());
  const maxRunAge = weekend ? 84 : 36;
  const checks: Check[] = [];

  const [{ data: runs }, { data: cfg }, { data: controls }] = await Promise.all([
    svc.from("agent_runs").select("agent_type,market,status,started_at,result_summary")
      .in("agent_type", ["research", "paper_trader", "position_monitor", "label_maturation", "learner"])
      .order("started_at", { ascending: false }).limit(100),
    svc.from("strategy_config").select("security_locked,app_paused,trading_enabled_us,trading_enabled_india,active_account_us,active_account_india,live_auto_enabled").limit(1).maybeSingle(),
    svc.from("readiness_controls").select("robinhood_canary_verified,kite_canary_verified").eq("id", true).maybeSingle(),
  ]);

  for (const market of ["us", "india"] as const) {
    for (const type of ["research", "paper_trader", "position_monitor"] as const) {
      const row = (runs ?? []).find((r: any) => r.agent_type === type && r.market === market);
      checks.push({ key: `${market}_${type}_fresh`, pass: row?.status === "done" && hoursSince(row.started_at) <= maxRunAge,
        requiredFor: "engineering", detail: row ? `${row.status}, ${hoursSince(row.started_at).toFixed(1)}h old` : "no market-scoped run" });
    }

    const { data: observations } = await svc.from("decision_observations")
      .select("id,evidence_confidence").eq("market", market).order("ts", { ascending: false }).limit(50);
    const confidenceCoverage = observations?.length
      ? observations.filter((o: any) => Number.isFinite(Number(o.evidence_confidence))).length / observations.length : 0;
    checks.push({ key: `${market}_confidence_coverage`, pass: confidenceCoverage >= 0.8, requiredFor: "engineering",
      detail: `${Math.round(confidenceCoverage * 100)}% of latest ${observations?.length ?? 0}` });

    const { data: allObservationIds } = await svc.from("decision_observations")
      .select("id").eq("market", market).limit(5000);
    const ids = (allObservationIds ?? []).map((o: any) => o.id);
    const { count: labelCount } = ids.length
      ? await svc.from("observation_labels").select("id", { count: "exact", head: true }).in("observation_id", ids)
      : { count: 0 };
    checks.push({ key: `${market}_forward_labels`, pass: (labelCount ?? 0) >= 60, requiredFor: "autonomous",
      detail: `${labelCount ?? 0} labels on latest observation cohort; need >=60` });

    const [{ count: shadows }, { count: models }] = await Promise.all([
      svc.from("shadow_decisions").select("id", { count: "exact", head: true }).eq("market", market),
      svc.from("model_artifacts").select("id", { count: "exact", head: true }).eq("market", market),
    ]);
    checks.push({ key: `${market}_shadow_sample`, pass: (shadows ?? 0) >= 100, requiredFor: "autonomous", detail: `${shadows ?? 0}/100 shadow decisions` });
    checks.push({ key: `${market}_validated_model`, pass: (models ?? 0) >= 1, requiredFor: "autonomous", detail: `${models ?? 0} model artifacts` });
  }

  checks.push({ key: "security_not_locked", pass: !(cfg as any)?.security_locked, requiredFor: "engineering", detail: `security_locked=${Boolean((cfg as any)?.security_locked)}` });
  checks.push({ key: "robinhood_agentic_account", pass: (cfg as any)?.active_account_us === "605420660", requiredFor: "engineering", detail: "US account must be the agentic account" });
  checks.push({ key: "india_account_configured", pass: Boolean((cfg as any)?.active_account_india), requiredFor: "engineering", detail: "Kite active account required" });
  checks.push({ key: "robinhood_canary", pass: Boolean((controls as any)?.robinhood_canary_verified), requiredFor: "autonomous", detail: "human-verified canary required" });
  checks.push({ key: "kite_canary", pass: Boolean((controls as any)?.kite_canary_verified), requiredFor: "autonomous", detail: "human-verified canary required" });

  const engineeringChecks = checks.filter(c => c.requiredFor === "engineering");
  const autonomousChecks = checks;
  const engineeringScore = 10 * engineeringChecks.filter(c => c.pass).length / engineeringChecks.length;
  const autonomousScore = 10 * autonomousChecks.filter(c => c.pass).length / autonomousChecks.length;
  const blockers = checks.filter(c => !c.pass).map(c => `${c.key}: ${c.detail}`);
  const result = {
    engineering_score: Number(engineeringScore.toFixed(2)), autonomous_score: Number(autonomousScore.toFixed(2)),
    engineering_ready: engineeringChecks.every(c => c.pass), autonomous_ready: autonomousChecks.every(c => c.pass),
    checks, blockers,
  };
  const { data, error } = await svc.from("readiness_runs").insert(result).select("id,checked_at").single();
  if (error) throw new Error(`readiness ledger insert failed: ${error.message}`);
  return { ...result, ...data };
}

export async function POST(req: NextRequest) {
  if (!(await authorize(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json(await runReadiness()); }
  catch (e: any) { return NextResponse.json({ error: e?.message ?? "readiness failed" }, { status: 500 }); }
}

export async function GET(req: NextRequest) {
  if (!(await authorize(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const svc = createServiceClient();
  const { data, error } = await svc.from("readiness_runs").select("*").order("checked_at", { ascending: false }).limit(1).maybeSingle();
  return error ? NextResponse.json({ error: error.message }, { status: 500 }) : NextResponse.json(data ?? { status: "not_run" });
}
