import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const PROFILES = {
  conservative: { score_threshold: 72, position_size_pct: 7, stop_loss_pct: 5, target_pct: 12, max_positions_per_sector: 2 },
  balanced:     { score_threshold: 60, position_size_pct: 10, stop_loss_pct: 7, target_pct: 20, max_positions_per_sector: 3 },
  aggressive:   { score_threshold: 52, position_size_pct: 15, stop_loss_pct: 10, target_pct: 35, max_positions_per_sector: 4 },
};

const VALID_TRADING_MODES = ["disabled", "manual", "auto"] as const;
const VALID_PROFILES = ["conservative", "balanced", "aggressive"] as const;

// PATCH: set risk profile (and optionally override individual params)
export async function PATCH(req: NextRequest) {
  // Require authenticated owner — risk and trading config must not be publicly mutable
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct, trading_mode, broker, max_positions_per_sector } = body;

  // Validate bounded inputs — reject out-of-range values
  if (risk_profile !== undefined && !VALID_PROFILES.includes(risk_profile)) {
    return NextResponse.json({ error: `Invalid risk_profile. Must be one of: ${VALID_PROFILES.join(", ")}` }, { status: 400 });
  }
  if (trading_mode !== undefined && !VALID_TRADING_MODES.includes(trading_mode)) {
    return NextResponse.json({ error: `Invalid trading_mode. Must be one of: ${VALID_TRADING_MODES.join(", ")}` }, { status: 400 });
  }
  if (score_threshold !== undefined && (score_threshold < 0 || score_threshold > 100)) {
    return NextResponse.json({ error: "score_threshold must be 0–100" }, { status: 400 });
  }
  if (position_size_pct !== undefined && (position_size_pct < 1 || position_size_pct > 25)) {
    return NextResponse.json({ error: "position_size_pct must be 1–25" }, { status: 400 });
  }
  if (stop_loss_pct !== undefined && (stop_loss_pct < 1 || stop_loss_pct > 30)) {
    return NextResponse.json({ error: "stop_loss_pct must be 1–30" }, { status: 400 });
  }
  if (target_pct !== undefined && (target_pct < 1 || target_pct > 100)) {
    return NextResponse.json({ error: "target_pct must be 1–100" }, { status: 400 });
  }
  if (max_positions_per_sector !== undefined && (max_positions_per_sector < 1 || max_positions_per_sector > 6)) {
    return NextResponse.json({ error: "max_positions_per_sector must be 1–6" }, { status: 400 });
  }

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
  if (trading_mode !== undefined) update.trading_mode = trading_mode;
  if (broker !== undefined) update.broker = broker;
  if (max_positions_per_sector !== undefined) update.max_positions_per_sector = max_positions_per_sector;

  // Resilient write — max_positions_per_sector column may not exist until
  // migration 056 is applied; retry without it so saving a profile still works.
  const { error: updErr } = await svc.from("strategy_config").update(update).eq("id", existing.id);
  if (updErr && "max_positions_per_sector" in update) {
    const { max_positions_per_sector: _omit, ...rest } = update;
    await svc.from("strategy_config").update(rest).eq("id", existing.id);
  }
  return NextResponse.json({ ok: true, ...update });
}

// GET: return current profile
export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const { data } = await svc
    .from("strategy_config")
    .select("risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct, trading_enabled, trading_mode, broker")
    .single();
  return NextResponse.json(data ?? {});
}
