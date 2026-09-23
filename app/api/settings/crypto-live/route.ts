import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { CRYPTO_LIVE_ENABLED } from "@/lib/autonomy";
import { readRobinhoodCryptoExecutionSnapshot } from "@/lib/robinhood-mcp";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";

export const dynamic = "force-dynamic";

const CONFIRMATION_TEXT = "ENABLE CRYPTO LIVE";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const svc = createServiceClient();
  const { data } = await svc.from("strategy_config")
    .select("crypto_live_auto_enabled, crypto_live_lease_usd")
    .limit(1).single();

  const { data: openPositions } = await svc.from("crypto_live_positions")
    .select("symbol, qty, avg_cost").is("closed_at", null);

  // Real account-eligibility check, same one the cron itself gates on -- the
  // Settings panel should never claim "ready" when the live cron would
  // refuse for the exact same reason.
  const snapshot = await readRobinhoodCryptoExecutionSnapshot([...CRYPTO_SYMBOLS]);

  return NextResponse.json({
    ...data,
    deployment_flag_active: CRYPTO_LIVE_ENABLED,
    robinhood_crypto_account_eligible: snapshot.accountEligible,
    open_positions: openPositions ?? [],
  });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = await req.json();
  const { action, confirmation_text, lease_usd } = body;

  if (!["enable", "disable", "set_lease"].includes(action)) {
    return NextResponse.json({ error: "action must be enable, disable, or set_lease" }, { status: 400 });
  }

  const svc = createServiceClient();
  const { data: existing } = await svc.from("strategy_config").select("id").limit(1).single();
  if (!existing) return NextResponse.json({ error: "No strategy config" }, { status: 404 });

  const update: Record<string, any> = {};

  if (action === "enable") {
    if (!CRYPTO_LIVE_ENABLED) {
      return NextResponse.json({
        error: "CRYPTO_LIVE_ENABLED is false in deployment config. Set it to true (Vercel env) to enable crypto's live door.",
      }, { status: 403 });
    }
    if (confirmation_text !== CONFIRMATION_TEXT) {
      return NextResponse.json({ error: `Type "${CONFIRMATION_TEXT}" to confirm` }, { status: 400 });
    }
    update.crypto_live_auto_enabled = true;
  }

  if (action === "disable") {
    update.crypto_live_auto_enabled = false;
  }

  if (action === "set_lease") {
    const n = Number(lease_usd);
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "lease_usd must be a non-negative number" }, { status: 400 });
    }
    update.crypto_live_lease_usd = n;
  }

  const { error } = await svc.from("strategy_config").update(update).eq("id", existing.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...update });
}
