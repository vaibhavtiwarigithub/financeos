import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const { data } = await svc
    .from("strategy_config")
    .select("app_paused, paused_at, paused_reason")
    .limit(1)
    .single();
  return NextResponse.json(data ?? { app_paused: false });
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const paused = Boolean(body.paused);
  const reason = body.reason ?? null;

  const svc = createServiceClient();
  const { data: config } = await svc.from("strategy_config").select("id").limit(1).single();
  if (!config) return NextResponse.json({ error: "No config" }, { status: 404 });

  await svc.from("strategy_config").update({
    app_paused: paused,
    paused_at: paused ? new Date().toISOString() : null,
    paused_reason: reason,
    updated_at: new Date().toISOString(),
  } as any).eq("id", (config as any).id);

  return NextResponse.json({ ok: true, app_paused: paused });
}
