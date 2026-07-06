import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { listBrokers } from "@/lib/brokers/registry";
import { RISK_PROFILES as PROFILES } from "@/lib/risk-profiles";

export const dynamic = "force-dynamic";

const VALID_TRADING_MODES = ["disabled", "manual", "auto"] as const;
const VALID_PROFILES = ["conservative", "balanced", "aggressive"] as const;

// PATCH: set risk profile (and optionally override individual params)
export async function PATCH(req: NextRequest) {
  // Require authenticated owner — risk and trading config must not be publicly mutable
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct, trading_mode, broker, max_positions_per_sector, ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct, exit_hysteresis, posture, posture_days, active_broker_us, active_broker_india } = body;

  if (active_broker_us !== undefined && !listBrokers("us").some(b => b.id === active_broker_us)) {
    return NextResponse.json({ error: "Invalid active_broker_us" }, { status: 400 });
  }
  if (active_broker_india !== undefined && !listBrokers("india").some(b => b.id === active_broker_india)) {
    return NextResponse.json({ error: "Invalid active_broker_india" }, { status: 400 });
  }

  if (posture !== undefined && posture !== null && !VALID_PROFILES.includes(posture)) {
    return NextResponse.json({ error: `Invalid posture. Must be one of: ${VALID_PROFILES.join(", ")}, or null to cancel` }, { status: 400 });
  }
  if (posture && (posture_days === undefined || posture_days < 1 || posture_days > 90)) {
    return NextResponse.json({ error: "posture_days must be 1–90 when setting a posture" }, { status: 400 });
  }

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
  if (ks_daily_loss_pct !== undefined && (ks_daily_loss_pct > -1 || ks_daily_loss_pct < -50)) {
    return NextResponse.json({ error: "ks_daily_loss_pct must be -50 to -1" }, { status: 400 });
  }
  if (ks_drawdown_pct !== undefined && (ks_drawdown_pct < 5 || ks_drawdown_pct > 60)) {
    return NextResponse.json({ error: "ks_drawdown_pct must be 5–60" }, { status: 400 });
  }
  if (ks_accuracy_pct !== undefined && (ks_accuracy_pct < 10 || ks_accuracy_pct > 70)) {
    return NextResponse.json({ error: "ks_accuracy_pct must be 10–70" }, { status: 400 });
  }
  if (exit_hysteresis !== undefined && (exit_hysteresis < 1 || exit_hysteresis > 40)) {
    return NextResponse.json({ error: "exit_hysteresis must be 1–40" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: existing } = await svc.from("strategy_config").select("id, risk_profile, posture, base_risk_profile").limit(1).single();
  if (!existing) return NextResponse.json({ error: "No strategy config" }, { status: 404 });

  // Start with profile defaults if profile specified
  const defaults = risk_profile ? PROFILES[risk_profile as keyof typeof PROFILES] : {};

  const update: Record<string, any> = { ...defaults };
  if (risk_profile) update.risk_profile = risk_profile;

  // Part B — time-bound posture. Setting one applies its dials with an expiry;
  // the research cron auto-reverts to base_risk_profile once expired. This
  // Object.assign runs BEFORE the individual per-field overrides below (not
  // after) so an explicit override sent in the SAME request (e.g.
  // {posture:'aggressive', position_size_pct:3}) always wins over the
  // posture's fixed profile dials, instead of being silently clobbered.
  let journalEntry: { entry_type: string; summary: string } | null = null;
  if (posture) {
    const base = existing.posture ? existing.base_risk_profile : existing.risk_profile;
    Object.assign(update, PROFILES[posture as keyof typeof PROFILES]);
    update.risk_profile = posture;
    update.posture = posture;
    update.base_risk_profile = base ?? "balanced";
    const expiresAt = new Date(Date.now() + posture_days * 86400_000);
    update.posture_expires_at = expiresAt.toISOString();
    journalEntry = { entry_type: "posture_change", summary: `Posture ${posture} for ${posture_days}d (expires ${expiresAt.toISOString().slice(0, 10)}), reverts to ${base ?? "balanced"}` };
  } else if (posture === null && existing.posture) {
    const base = existing.base_risk_profile ?? "balanced";
    Object.assign(update, PROFILES[base as keyof typeof PROFILES]);
    update.risk_profile = base;
    update.posture = null;
    update.posture_expires_at = null;
    update.base_risk_profile = null;
    journalEntry = { entry_type: "posture_change", summary: `Posture canceled early, reverted to ${base}` };
  } else if (posture === null && !existing.posture) {
    // Cancel request with nothing active to cancel — tell the caller instead
    // of silently no-op'ing 200 OK, which could mask a stale-UI double-submit.
    return NextResponse.json({ ok: true, no_op: true, reason: "No active posture to cancel" });
  }

  if (score_threshold !== undefined) update.score_threshold = score_threshold;
  if (position_size_pct !== undefined) update.position_size_pct = position_size_pct;
  if (stop_loss_pct !== undefined) update.stop_loss_pct = stop_loss_pct;
  if (target_pct !== undefined) update.target_pct = target_pct;
  if (trading_mode !== undefined) update.trading_mode = trading_mode;
  if (broker !== undefined) update.broker = broker;
  if (active_broker_us !== undefined) update.active_broker_us = active_broker_us;
  if (active_broker_india !== undefined) update.active_broker_india = active_broker_india;
  if (max_positions_per_sector !== undefined) update.max_positions_per_sector = max_positions_per_sector;
  if (ks_daily_loss_pct !== undefined) update.ks_daily_loss_pct = ks_daily_loss_pct;
  if (ks_drawdown_pct !== undefined) update.ks_drawdown_pct = ks_drawdown_pct;
  if (ks_accuracy_pct !== undefined) update.ks_accuracy_pct = ks_accuracy_pct;
  if (exit_hysteresis !== undefined) update.exit_hysteresis = exit_hysteresis;

  // Resilient write — some columns may not exist on older schemas; retry
  // stripping the optional ones so saving a profile still works.
  const OPTIONAL_COLS = ["max_positions_per_sector", "ks_daily_loss_pct", "ks_drawdown_pct", "ks_accuracy_pct", "exit_hysteresis", "posture", "posture_expires_at", "base_risk_profile", "active_broker_us", "active_broker_india"];
  const { error: updErr } = await svc.from("strategy_config").update(update).eq("id", existing.id);
  if (updErr) {
    const rest = { ...update };
    for (const k of OPTIONAL_COLS) delete (rest as any)[k];
    await svc.from("strategy_config").update(rest).eq("id", existing.id);
  }
  if (journalEntry) {
    await svc.from("decision_journal").insert(journalEntry).then(() => {}, () => {});
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
    .select("risk_profile, score_threshold, position_size_pct, stop_loss_pct, target_pct, trading_enabled, trading_mode, broker, ks_daily_loss_pct, ks_drawdown_pct, ks_accuracy_pct, exit_hysteresis, posture, posture_expires_at, base_risk_profile, active_broker_us, active_broker_india")
    .single();
  return NextResponse.json(data ?? {});
}
