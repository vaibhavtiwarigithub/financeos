import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { runAutonomousShadow } from "@/lib/trading/autonomous-shadow";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";
  const provided = req.headers.get("x-cron-secret") ?? "";
  const authorized =
    secret.length > 0 &&
    provided.length === secret.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(secret));

  if (!authorized) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const svc = createServiceClient();
  const runId = crypto.randomUUID();

  try {
    const result = await runAutonomousShadow(svc, runId);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "shadow cron failed" }, { status: 500 });
  }
}
