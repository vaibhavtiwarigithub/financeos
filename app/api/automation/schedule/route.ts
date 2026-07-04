import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { SCHEDULED_JOBS, SCHEDULED_AGENT_RUN_TYPES } from "@/lib/schedule";

export const dynamic = "force-dynamic";

// Automation / schedule settings — single source of truth for every scheduled job.
// GET /api/automation/schedule
//
// Returns SCHEDULED_JOBS (from lib/schedule.ts) enriched, for each job that maps to an
// agent_type, with its most recent run's time + status from agent_runs. Jobs with no
// agent_runs rows (proposal-reminder, stale-check, briefs, embed, rescore, nav-snapshot)
// return last_run: null.

export async function GET(_req: NextRequest) {
  const userClient = await createClient();
  const {
    data: { user },
  } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();

  // Latest run per agent_type. Pull recent rows for the types the schedule cares about,
  // ordered newest-first, then keep the first (latest) we see per type.
  const lastByType: Record<string, { last_run: string | null; status: string | null }> = {};
  if (SCHEDULED_AGENT_RUN_TYPES.length) {
    const { data: runs, error } = await svc
      .from("agent_runs")
      .select("agent_type, status, started_at, completed_at")
      .in("agent_type", SCHEDULED_AGENT_RUN_TYPES)
      .order("started_at", { ascending: false })
      .limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    for (const r of (runs ?? []) as any[]) {
      if (!r.agent_type) continue;
      if (lastByType[r.agent_type]) continue; // already have the newest for this type
      lastByType[r.agent_type] = {
        last_run: r.completed_at ?? r.started_at ?? null,
        status: r.status ?? null,
      };
    }
  }

  const jobs = SCHEDULED_JOBS.map((j) => {
    const last = j.agentRunsType ? lastByType[j.agentRunsType] : null;
    return {
      name: j.name,
      agent: j.agent,
      time: j.time,
      days: j.days,
      runner: j.runner,
      editable: j.editable,
      description: j.description,
      handoff: j.handoff,
      agentRunsType: j.agentRunsType,
      last_run: last?.last_run ?? null,
      last_status: last?.status ?? null,
    };
  });

  return NextResponse.json({
    jobs,
    total: jobs.length,
    // Surfaced so the UI can render the "cloud crons decommissioned" banner truthfully.
    note:
      "All jobs run locally via Windows Task Scheduler. Cloud / Supabase edge-function crons were decommissioned. Schedules are read-only here — edit scripts/register-tasks.ps1 and re-run it.",
  });
}
