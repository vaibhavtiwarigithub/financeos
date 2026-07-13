import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadValidationAutomationPolicy, runAutomatedValidation } from "@/lib/validation/automation";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

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
  return NextResponse.json({ success: true, results });
}
