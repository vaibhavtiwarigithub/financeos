import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { checkWebullTokenHealth, captureWebullAccounts } from "@/lib/webull-mcp";

export const dynamic = "force-dynamic";

// Connection status for the Settings Webull card. Owner-only. Returns booleans +
// token-age only (never token material). Optionally includes a fail-soft account
// snapshot when connected (read-only). oauth_ready is always true — the OAuth
// /login + /callback routes are implemented.
export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;
  const svc = createServiceClient();
  // Vault-only token-age check: connected + stale/expiry. Also reports/resolves
  // the broker-token:webull issue so the badge can't lie.
  const health = await checkWebullTokenHealth(svc);

  // Only reach out to Webull for an account snapshot when actually connected and
  // not stale — otherwise return connection state alone.
  let accounts: Awaited<ReturnType<typeof captureWebullAccounts>> | undefined;
  if (health.connected && !health.stale) {
    accounts = await captureWebullAccounts();
  }

  return NextResponse.json({
    connected: health.connected,
    stale: health.stale,              // token present but past expiry → reconnect required
    expires_at: health.expiresAt,
    expires_in_ms: health.expiresInMs,
    has_refresh: health.hasRefresh,
    accounts,                          // read-only snapshot (undefined when not connected)
    oauth_ready: true,                 // OAuth /login + /callback are implemented
  });
}
