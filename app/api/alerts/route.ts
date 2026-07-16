import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("agent_alerts")
    .select("*")
    .eq("resolved", false)
    .or(`auto_expire_at.is.null,auto_expire_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ error: "System Health is temporarily unavailable" }, { status: 500 });
  return NextResponse.json({ alerts: data ?? [] });
}

export async function POST(req: NextRequest) {
  // Internal callers use emitAlert() (direct service-client write). This HTTP
  // path is for the owner UI / cron only — never anonymous (P1-3).
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const gate = await requireOwner();
    if (gate) return gate;
  }
  const body = await req.json();
  const svc = createServiceClient();
  const { error } = await svc.from("agent_alerts").insert({
    severity: body.severity ?? "warn",
    category: body.category ?? "system",
    title: body.title,
    detail: body.detail ?? null,
    auto_expire_at: body.auto_expire_at ?? null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json();
  const svc = createServiceClient();
  if (body.resolve_all) {
    await svc.from("agent_alerts").update({ resolved: true, resolved_at: new Date().toISOString() }).eq("resolved", false);
    return NextResponse.json({ ok: true });
  }
  const { error } = await svc.from("agent_alerts")
    .update({ resolved: true, resolved_at: new Date().toISOString() })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
