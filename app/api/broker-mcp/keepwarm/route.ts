import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { MCP_BROKERS } from "@/lib/brokers/mcp-registry";
import { getValidAccessToken } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Token KEEP-WARM. READ-ONLY, no tool calls, no order path.
//
// OAuth access tokens are short-lived (Webull ~1 day); the long-lived refresh
// token auto-mints a new one, but ONLY when getValidAccessToken sees the access
// token near/past expiry AND some caller invokes it before the REFRESH token's
// own window lapses. The account-snapshot + research crons already touch Webull
// daily, so the chain self-renews — this route is belt-and-suspenders insurance
// so the chain can never lapse even if those crons are paused.
//
// For every connected MCP broker it calls getValidAccessToken (which refreshes +
// rotates the refresh token via CAS when expiring). Not connected → skipped
// (no token is not a fault). A refresh FAILURE already raises a critical System
// Health issue inside getValidAccessToken, so the owner is notified to reconnect.
//
// GET/POST /api/broker-mcp/keepwarm — owner-gated or cron-gated (CRON_SECRET).
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    const gate = await requireOwner();
    if (gate) return gate;
  }

  const svc = createServiceClient();
  const results: Array<{ broker: string; ok: boolean; error?: string }> = [];

  for (const cfg of Object.values(MCP_BROKERS)) {
    const tk = await getValidAccessToken(svc, cfg);
    // "not connected" is expected for brokers the owner never linked — not a fault.
    results.push(
      tk.ok
        ? { broker: cfg.id, ok: true }
        : { broker: cfg.id, ok: false, error: tk.error }
    );
  }

  return NextResponse.json({ ok: true, ranAt: new Date().toISOString(), brokers: results });
}

// Alias so the pg_cron kairos_call_agent helper (which POSTs) can fire it.
export const POST = GET;
