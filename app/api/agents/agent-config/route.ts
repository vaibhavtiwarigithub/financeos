import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const { data, error } = await svc.from("agent_config").select("*").order("agent_name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ configs: data ?? [] });
}

export async function PATCH(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { agent_name, model, enabled, max_tokens, temperature, notes } = body;

  if (!agent_name) return NextResponse.json({ error: "agent_name required" }, { status: 400 });

  const svc = createServiceClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (model !== undefined) updates.model = model;
  if (enabled !== undefined) updates.enabled = enabled;
  if (max_tokens !== undefined) updates.max_tokens = max_tokens;
  if (temperature !== undefined) updates.temperature = temperature;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await svc
    .from("agent_config")
    .update(updates)
    .eq("agent_name", agent_name)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}
