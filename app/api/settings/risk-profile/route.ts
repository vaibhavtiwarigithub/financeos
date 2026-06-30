import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

const PROFILES = {
  conservative: { score_threshold: 72, position_size_pct: 7, stop_loss_pct: 5, target_pct: 12 },
  balanced:     { score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7, target_pct: 20 },
  aggressive:   { score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10, target_pct: 35 },
};

// PATCH: set risk profile (and optionally override individual params)
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct } = body;

  const svc = createServiceClient();
  const { data: existing } = await svc.from("strategy_config").select("id").limit(1).single();
  if (!existing) return NextResponse.json({ error: "No strategy config" }, { status: 404 });

  // Start with profile defaults if profile specified
  const defaults = risk_profile ? PROFILES[risk_profile as keyof typeof PROFILES] : {};

  const update: Record<string, any> = { ...defaults };
  if (risk_profile) update.risk_profile = risk_profile;
  if (score_threshold !== undefined) update.score_threshold = score_threshold;
  if (position_size_pct !== undefined) update.position_size_pct = position_size_pct;
  if (stop_loss_pct !== undefined) update.stop_loss_pct = stop_loss_pct;
  if (target_pct !== undefined) update.target_pct = target_pct;

  await svc.from("strategy_config").update(update).eq("id", existing.id);
  return NextResponse.json({ ok: true, ...update });
}

// GET: return current profile
export async function GET() {
  const svc = createServiceClient();
  const { data } = await svc
    .from("strategy_config")
    .select("risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct, trading_enabled, mode")
    .single();
  return NextResponse.json(data ?? {});
}
