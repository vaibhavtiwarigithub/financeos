import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { OWNER_EMAIL } from "@/lib/auth/owner";
import { reportIssue, resolveIssue } from "@/lib/system-health";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";

export const dynamic = "force-dynamic";
const ACTIVE = ["pending_approval", "armed", "triggering"];

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  const { data, error } = await svc.from("guardian_protection_plans")
    .select("id,symbol,qty,entry_price,stop_price,status,armed_at,triggered_at,terminal_reason,created_at,trigger_proposal_id")
    .in("status", ACTIVE).order("created_at", { ascending: false });
  if (error) {
    await reportIssue({ issueKey: "guardian-plans:us", severity: "warn", category: "broker", title: "US Guardian plans unavailable", detail: "The active plan ledger could not be read. Plan status and stop coverage are unknown; retry after database recovery." }, svc);
    return NextResponse.json({ error: "Guardian plans unavailable; retry or check System Health." }, { status: 503, headers: { "Cache-Control": "private, no-store" } });
  }
  await resolveIssue("guardian-plans:us", svc);
  // Owner-visible runtime truth, not proof that a holding has a broker stop.
  // Match the existing monitor's account scope; never return account identifiers.
  const [config, scan] = await Promise.all([
    svc.from("strategy_config").select("live_auto_enabled,app_paused,security_locked,active_account_us").limit(1).maybeSingle(),
    svc.from("agentic_position_scan_state").select("last_started_at,last_completed_at")
      .eq("account_id", "605420660").maybeSingle(),
  ]);
  return NextResponse.json({ plans: data ?? [], runtime: {
    deploymentEnabled: AUTONOMOUS_LIVE_ENABLED,
    configurationAvailable: !config.error && config.data != null,
    liveEnabled: config.error || !config.data ? null : config.data.live_auto_enabled === true,
    paused: config.error || !config.data ? null : config.data.app_paused === true || config.data.security_locked === true,
    permittedAccountSelected: config.error || !config.data ? null : config.data.active_account_us === "605420660",
    scanAvailable: !scan.error,
    lastScanStartedAt: scan.error ? null : scan.data?.last_started_at ?? null,
    lastScanCompletedAt: scan.error ? null : scan.data?.last_completed_at ?? null,
  } }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;
  const body = await req.json().catch(() => null);
  const planId = Number(body?.plan_id);
  const action = body?.action;
  if (!Number.isSafeInteger(planId) || !["arm", "decline", "cancel"].includes(action)) {
    return NextResponse.json({ error: "plan_id and action (arm, decline, or cancel) are required" }, { status: 400 });
  }
  const svc = createServiceClient();
  const { data: current, error: loadError } = await svc.from("guardian_protection_plans")
    .select("id,status,symbol,stop_price").eq("id", planId).maybeSingle();
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "Protection plan not found" }, { status: 404 });
  const status = String((current as any).status);
  const isArm = action === "arm" && status === "pending_approval";
  const isDecline = action === "decline" && status === "pending_approval";
  const isCancel = action === "cancel" && status === "armed";
  if (!isArm && !isDecline && !isCancel) {
    return NextResponse.json({ error: `Cannot ${action} a plan in '${status}' state` }, { status: 409 });
  }
  const nextStatus = isArm ? "armed" : isDecline ? "declined" : "cancelled";
  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await svc.from("guardian_protection_plans").update({
    status: nextStatus, armed_at: isArm ? now : null, armed_by: isArm ? OWNER_EMAIL : null,
    terminal_reason: isArm ? null : action === "decline" ? "owner_declined" : "owner_cancelled",
  }).eq("id", planId).eq("status", status).select("*").maybeSingle();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  if (!updated) return NextResponse.json({ error: "Protection plan changed concurrently; refresh and retry" }, { status: 409 });
  const eventType = isArm ? "armed" : isDecline ? "declined" : "cancelled";
  const { error: eventError } = await svc.from("guardian_protection_events").insert({
    plan_id: planId, event_type: eventType, actor: "owner", reason_code: `owner_${action}`,
    payload: { symbol: (current as any).symbol, stop_price: (current as any).stop_price },
  });
  if (eventError) return NextResponse.json({ error: `Plan updated but event logging failed: ${eventError.message}` }, { status: 500 });
  return NextResponse.json({ plan: updated, message: isArm
    ? "Guardian is armed. This did not place a broker order."
    : `Guardian plan ${action}d.` });
}
