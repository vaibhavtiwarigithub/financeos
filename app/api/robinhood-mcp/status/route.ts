import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { checkRobinhoodTokenHealth } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";

// Connection status for the Settings card. Returns booleans only — never token
// material. `oauth_ready` is false until the OAuth flow is implemented.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  // Vault-only token-age check: connected + stale/expiry, no Robinhood API call.
  // Also reports/resolves the broker-token issue so the badge can't lie.
  const health = await checkRobinhoodTokenHealth(svc);
  const { data: cfg } = await svc.from("strategy_config").select("robinhood_mcp_enabled, live_account_source").limit(1).maybeSingle();
  return NextResponse.json({
    connected: health.connected,
    stale: health.stale,              // token present but past expiry → reconnect required
    expires_at: health.expiresAt,
    expires_in_ms: health.expiresInMs,
    has_refresh: health.hasRefresh,
    enabled: !!(cfg as any)?.robinhood_mcp_enabled,
    live_account_source: (cfg as any)?.live_account_source ?? "claude_exec",
    oauth_ready: true, // OAuth /login + /callback are implemented (verified Robinhood metadata)
  });
}
