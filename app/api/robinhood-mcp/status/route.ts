import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { checkRobinhoodTokenHealth } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";

// Connection status for the Settings card. Returns booleans only — never token
// material. Robinhood's documented integration is platform-level MCP setup;
// this app must not present its bespoke browser OAuth attempt as supported after
// Robinhood rejected it post-consent before our callback was reached.
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
    oauth_ready: false,
    oauth_blocker: "Robinhood rejected the in-app authorization after consent. Connect the Robinhood Trading MCP through your supported AI platform instead; Kairos will not attempt to copy that platform credential.",
  });
}
