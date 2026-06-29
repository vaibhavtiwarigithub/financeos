import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const { data, error } = await svc
    .from("agent_alerts")
    .select("*")
    .eq("resolved", false)
    .or(`auto_expire_at.is.null,auto_expire_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return NextResponse.json({ alerts: [] });
  return NextResponse.json({ alerts: data ?? [] });
}

export async function POST(req: NextRequest) {
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
