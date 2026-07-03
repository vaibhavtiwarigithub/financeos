import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const [{ data: config }, { data: history }] = await Promise.all([
    svc.from("learner_config").select("*").order("dimension"),
    svc.from("signal_weights_history").select("*").order("snapshot_at", { ascending: false }).limit(30),
  ]);
  return NextResponse.json({ config: config ?? [], history: history ?? [] });
}

export async function PATCH(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { dimension, learn_from, allow_mutation, min_confidence } = body;
  if (!dimension) return NextResponse.json({ error: "dimension required" }, { status: 400 });

  const svc = createServiceClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (learn_from !== undefined) updates.learn_from = learn_from;
  if (allow_mutation !== undefined) updates.allow_mutation = allow_mutation;
  if (min_confidence !== undefined) updates.min_confidence = min_confidence;

  const { data, error } = await svc.from("learner_config").update(updates).eq("dimension", dimension).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ config: data });
}

export async function POST(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { action, history_id } = await req.json();
  const svc = createServiceClient();
  const today = new Date().toISOString().slice(0, 10);

  if (action === "rollback") {
    if (!history_id) return NextResponse.json({ error: "history_id required" }, { status: 400 });
    const { data: snap } = await svc.from("signal_weights_history").select("*").eq("id", history_id).single();
    if (!snap) return NextResponse.json({ error: "Snapshot not found" }, { status: 404 });

    const { data: current } = await svc.from("signal_weights").select("*").single();
    if (current) {
      await svc.from("signal_weights_history").insert({
        run_date: today, trigger: "manual_reset",
        fundamental_weight: (current as any).fundamental_weight,
        technical_weight: (current as any).technical_weight,
        sentiment_weight: (current as any).sentiment_weight,
        macro_weight: (current as any).macro_weight,
        insider_weight: (current as any).insider_weight,
        notes: `Pre-rollback snapshot. Rolling back to snapshot id=${history_id} from ${(snap as any).run_date}`,
      });
      const updates: Record<string, unknown> = {};
      if ((snap as any).fundamental_weight != null) updates.fundamental_weight = (snap as any).fundamental_weight;
      if ((snap as any).technical_weight != null) updates.technical_weight = (snap as any).technical_weight;
      if ((snap as any).sentiment_weight != null) updates.sentiment_weight = (snap as any).sentiment_weight;
      if ((snap as any).macro_weight != null) updates.macro_weight = (snap as any).macro_weight;
      if ((snap as any).insider_weight != null) updates.insider_weight = (snap as any).insider_weight;
      await svc.from("signal_weights").update(updates).eq("id", (current as any).id);
    }
    return NextResponse.json({ success: true, rolledBackTo: (snap as any).run_date });
  }

  if (action === "factory_reset") {
    const { data: current } = await svc.from("signal_weights").select("*").single();
    if (current) {
      await svc.from("signal_weights_history").insert({
        run_date: today, trigger: "manual_reset",
        fundamental_weight: (current as any).fundamental_weight,
        technical_weight: (current as any).technical_weight,
        sentiment_weight: (current as any).sentiment_weight,
        macro_weight: (current as any).macro_weight,
        insider_weight: (current as any).insider_weight,
        notes: "Pre-factory-reset snapshot. User triggered factory reset to 0.20 equal weights.",
      });
      await svc.from("signal_weights").update({
        fundamental_weight: 0.20,
        technical_weight: 0.20,
        sentiment_weight: 0.20,
        macro_weight: 0.20,
        insider_weight: 0.20,
      } as any).eq("id", (current as any).id);
    }
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
