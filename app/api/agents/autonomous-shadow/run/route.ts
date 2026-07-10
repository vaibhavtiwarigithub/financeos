import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { runAutonomousShadow } from "@/lib/trading/autonomous-shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const runId = crypto.randomUUID();

  try {
    const result = await runAutonomousShadow(svc, runId);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "shadow run failed" }, { status: 500 });
  }
}
