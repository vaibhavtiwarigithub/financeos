import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { getShadowProgramStatuses } from "@/lib/shadows/status";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const programs = await getShadowProgramStatuses(svc);
  const trackedCalls = programs.reduce((sum, program) =>
    sum + (program.calls.mode === "tracked" ? program.calls.recorded ?? 0 : 0), 0);

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    summary: {
      total: programs.length,
      collecting: programs.filter((program) => program.lifecycle === "collecting" || program.lifecycle === "paper_active").length,
      readyForReview: programs.filter((program) => program.lifecycle === "ready_for_review").length,
      blockedOrIdle: programs.filter((program) => ["blocked", "idle", "off"].includes(program.lifecycle)).length,
      trackedCalls7d: trackedCalls,
    },
    programs,
  });
}
