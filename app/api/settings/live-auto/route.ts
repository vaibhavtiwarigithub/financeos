import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";

export const dynamic = "force-dynamic";

const CONFIRMATION_TEXT = "ENABLE AUTO";
const MAX_LEASE_HOURS = 24;

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data } = await svc
    .from("strategy_config")
    .select(
      "live_auto_enabled, live_auto_enabled_until, live_auto_policy_version," +
      "live_auto_daily_cap_usd, live_auto_max_per_order_usd, live_auto_min_evidence_confidence," +
      "live_auto_max_open_positions, live_auto_max_orders_per_day"
    )
    .limit(1)
    .single();

  return NextResponse.json({
    ...data,
    // Inform the UI whether the deployment flag is active. DB toggle alone
    // never enables autonomous orders — the deployment flag must also be true.
    deployment_flag_active: AUTONOMOUS_LIVE_ENABLED,
  });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json();
  const {
    action, // 'enable' | 'disable' | 'update_caps'
    confirmation_text,
    lease_hours,
    live_auto_daily_cap_usd,
    live_auto_max_per_order_usd,
    live_auto_min_evidence_confidence,
    live_auto_max_open_positions,
    live_auto_max_orders_per_day,
  } = body;

  if (!["enable", "disable", "update_caps"].includes(action)) {
    return NextResponse.json({ error: "action must be enable, disable, or update_caps" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: existing } = await svc.from("strategy_config").select("id, live_auto_enabled, live_auto_enabled_until").limit(1).single();
  if (!existing) return NextResponse.json({ error: "No strategy config" }, { status: 404 });

  const update: Record<string, any> = {};
  let journalSummary = "";

  if (action === "enable") {
    // Deployment flag must be true — owner cannot enable what isn't deployed.
    if (!AUTONOMOUS_LIVE_ENABLED) {
      return NextResponse.json({
        error: "AUTONOMOUS_LIVE_ENABLED is false in deployment config. Set it to true to enable autonomous trading.",
      }, { status: 403 });
    }
    if (confirmation_text !== CONFIRMATION_TEXT) {
      return NextResponse.json({ error: `Type "${CONFIRMATION_TEXT}" to confirm enabling autonomous trading` }, { status: 400 });
    }
    const lh = Number(lease_hours ?? 4);
    if (!Number.isInteger(lh) || lh < 1 || lh > MAX_LEASE_HOURS) {
      return NextResponse.json({ error: `lease_hours must be 1–${MAX_LEASE_HOURS}` }, { status: 400 });
    }
    const expiresAt = new Date(Date.now() + lh * 3_600_000).toISOString();
    update.live_auto_enabled = true;
    update.live_auto_enabled_until = expiresAt;
    journalSummary = `Autonomous trading ENABLED — ${lh}h lease expires ${expiresAt}`;
  }

  if (action === "disable") {
    update.live_auto_enabled = false;
    update.live_auto_enabled_until = null;
    journalSummary = "Autonomous trading DISABLED by owner";
  }

  // Cap updates allowed independently of enable/disable.
  if (action === "update_caps" || action === "enable") {
    for (const [field, val] of [
      ["live_auto_daily_cap_usd", live_auto_daily_cap_usd],
      ["live_auto_max_per_order_usd", live_auto_max_per_order_usd],
    ] as const) {
      if (val !== undefined) {
        if (val !== null && (!Number.isFinite(Number(val)) || Number(val) <= 0)) {
          return NextResponse.json({ error: `${field} must be a positive number or null` }, { status: 400 });
        }
        update[field] = val === null ? null : Number(val);
      }
    }
    if (live_auto_min_evidence_confidence !== undefined) {
      const c = Number(live_auto_min_evidence_confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) {
        return NextResponse.json({ error: "live_auto_min_evidence_confidence must be 0–1" }, { status: 400 });
      }
      // Auto path has no acceptLowQuality override — enforce minimum floor.
      if (c < 0.6) {
        return NextResponse.json({ error: "live_auto_min_evidence_confidence cannot be below 0.6 for autonomous path" }, { status: 400 });
      }
      update.live_auto_min_evidence_confidence = c;
    }
    if (live_auto_max_open_positions !== undefined) {
      const p = Number(live_auto_max_open_positions);
      if (!Number.isInteger(p) || p < 1 || p > 20) {
        return NextResponse.json({ error: "live_auto_max_open_positions must be 1–20" }, { status: 400 });
      }
      update.live_auto_max_open_positions = p;
    }
    if (live_auto_max_orders_per_day !== undefined) {
      const o = Number(live_auto_max_orders_per_day);
      if (!Number.isInteger(o) || o < 1 || o > 10) {
        return NextResponse.json({ error: "live_auto_max_orders_per_day must be 1–10" }, { status: 400 });
      }
      update.live_auto_max_orders_per_day = o;
    }
    if (action === "update_caps") {
      journalSummary = `Autonomous trading caps updated: ${JSON.stringify(Object.fromEntries(Object.entries(update).filter(([k]) => k.startsWith("live_auto_"))))}`;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true, no_op: true });
  }

  // Journal entry must write BEFORE config change (fail closed).
  if (journalSummary) {
    const { error: jErr } = await svc.from("decision_journal").insert({
      entry_type: "live_auto_config_change",
      summary: journalSummary,
    } as any);
    if (jErr) {
      return NextResponse.json({ error: `Journal write failed — config not changed: ${jErr.message}` }, { status: 500 });
    }
  }

  const { error: updErr } = await svc.from("strategy_config").update(update).eq("id", (existing as any).id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...update });
}
