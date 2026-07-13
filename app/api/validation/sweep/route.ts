import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadValidationAutomationPolicy, runAutomatedValidation } from "@/lib/validation/automation";
import { reportIssue, resolveIssue } from "@/lib/system-health";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Stable System Health key: this weekly pg_cron runs unattended, so an execution
// failure would otherwise be invisible. Report on any error, resolve on a clean run.
const HEALTH_KEY = "cron-failed:kairos-validation-sweep";

// Bounded recovery path for challengers created outside LearnerAgent or
// interrupted before deterministic validation completed.
export async function POST(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const client = await createClient();
    const { data: { user } } = await client.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const results: Record<string, unknown[]> = { us: [], india: [] };
  try {
    for (const market of ["us", "india"] as const) {
      const policy = await loadValidationAutomationPolicy(svc, market);
      if (!policy.enabled) {
        results[market].push({ skipped: "automation_disabled" });
        continue;
      }
      const { data, error } = await svc.from("strategy_versions")
        .select("id").eq("market", market).eq("state", "challenger")
        .is("validation_experiment_id", null).order("created_at", { ascending: true }).limit(5);
      if (error) {
        results[market].push({ error: error.message });
        continue;
      }
      for (const row of data ?? []) {
        try {
          results[market].push(await runAutomatedValidation(svc, { market, challengerId: row.id }));
        } catch (error) {
          results[market].push({ challengerId: row.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } catch (e) {
    // Hard failure before/while sweeping — surface it and stop pretending success.
    const detail = e instanceof Error ? e.message : String(e);
    await reportIssue({
      issueKey: HEALTH_KEY, severity: "warn", category: "cron",
      title: "Validation sweep failed to run",
      detail: `kairos-validation-sweep threw: ${detail}`.slice(0, 500),
    });
    return NextResponse.json({ success: false, error: detail, results }, { status: 500 });
  }

  // Collect per-market / per-challenger errors (skips + validated results are fine).
  const errs: string[] = [];
  for (const market of ["us", "india"] as const) {
    for (const r of results[market]) {
      if (r && typeof r === "object" && "error" in (r as any)) {
        errs.push(`${market}: ${String((r as any).error)}`);
      }
    }
  }

  if (errs.length > 0) {
    await reportIssue({
      issueKey: HEALTH_KEY, severity: "warn", category: "cron",
      title: `Validation sweep had ${errs.length} failure(s)`,
      detail: errs.join("; ").slice(0, 500),
    });
  } else {
    // Clean run (including all-disabled) clears any prior open alert.
    await resolveIssue(HEALTH_KEY);
  }

  return NextResponse.json({ success: errs.length === 0, results });
}
