import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { LEVERAGED_LIVE_ENABLED } from "@/lib/autonomy";
import { PROTECTIVE_PLACEMENT_WORKER_AVAILABLE } from "@/lib/protective/coverage";

export const dynamic = "force-dynamic";

const CONFIRMATION_TEXT = "ENABLE LEVERAGED LIVE";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data } = await svc.from("strategy_config")
    .select("leveraged_live_auto_enabled, leveraged_sleeve_live_lease_usd, protective_orders_enabled")
    .limit(1).single();

  const { data: openPositions } = await svc.from("leveraged_live_positions")
    .select("symbol, qty, avg_cost").is("closed_at", null);

  return NextResponse.json({
    ...data,
    // Independent from core-equity's own AUTONOMOUS_LIVE_ENABLED — see
    // lib/autonomy.ts's LEVERAGED_LIVE_ENABLED comment for why these were
    // deliberately decoupled 2026-09-23.
    deployment_flag_active: LEVERAGED_LIVE_ENABLED,
    protective_worker_available: PROTECTIVE_PLACEMENT_WORKER_AVAILABLE,
    open_positions: openPositions ?? [],
  });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json();
  const { action, confirmation_text, lease_usd, protective_orders_enabled } = body;

  if (!["enable", "disable", "set_lease", "set_protective_orders"].includes(action)) {
    return NextResponse.json({ error: "action must be enable, disable, set_lease, or set_protective_orders" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: existing } = await svc.from("strategy_config").select("id").limit(1).single();
  if (!existing) return NextResponse.json({ error: "No strategy config" }, { status: 404 });

  const update: Record<string, any> = {};

  if (action === "enable") {
    if (!LEVERAGED_LIVE_ENABLED) {
      return NextResponse.json({
        error: "LEVERAGED_LIVE_ENABLED is false in deployment config. Set it to true (Vercel env) to enable the leveraged sleeve's live door.",
      }, { status: 403 });
    }
    if (confirmation_text !== CONFIRMATION_TEXT) {
      return NextResponse.json({ error: `Type "${CONFIRMATION_TEXT}" to confirm` }, { status: 400 });
    }
    update.leveraged_live_auto_enabled = true;
  }

  if (action === "disable") {
    update.leveraged_live_auto_enabled = false;
  }

  if (action === "set_lease") {
    const n = Number(lease_usd);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "lease_usd must be a non-negative number" }, { status: 400 });
    }
    update.leveraged_sleeve_live_lease_usd = n;
  }

  if (action === "set_protective_orders") {
    if (typeof protective_orders_enabled !== "boolean") {
      return NextResponse.json({ error: "protective_orders_enabled must be a boolean" }, { status: 400 });
    }
    // Shared flag: also gates core-equity's own (currently unused) protective
    // stop placement — see features/hybrid-stop/FEATURE_ARCHITECTURE.md. Not
    // leveraged-sleeve-specific by design; the UI label says so explicitly.
    update.protective_orders_enabled = protective_orders_enabled;
  }

  const { error } = await svc.from("strategy_config").update(update).eq("id", existing.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...update });
}
