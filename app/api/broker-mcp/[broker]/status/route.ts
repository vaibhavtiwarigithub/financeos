import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";
import { getMcpBroker } from "@/lib/brokers/mcp-registry";
import { checkTokenHealth, captureAccounts } from "@/lib/brokers/mcp-driver";

export const dynamic = "force-dynamic";

// Connection status for the Settings MCP-broker card. Owner-only. Returns
// booleans + token-age only (never token material). Optionally includes a
// fail-soft read-only account snapshot when connected and not stale. Echoes the
// broker id/label/currency so the generic card can render itself.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ broker: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;

  const { broker } = await params;
  const cfg = getMcpBroker(broker);
  if (!cfg) return NextResponse.json({ error: `unknown MCP broker '${broker}'` }, { status: 404 });

  const svc = createServiceClient();
  const health = await checkTokenHealth(svc, cfg);

  let accounts: Awaited<ReturnType<typeof captureAccounts>> | undefined;
  if (health.connected && !health.stale) {
    accounts = await captureAccounts(cfg);
  }

  return NextResponse.json({
    broker: cfg.id,
    label: cfg.label,
    market: cfg.market,
    currency: cfg.currency,
    connected: health.connected,
    stale: health.stale,              // token present but past expiry → reconnect required
    expires_at: health.expiresAt,
    expires_in_ms: health.expiresInMs,
    has_refresh: health.hasRefresh,
    accounts,                          // read-only snapshot (undefined when not connected)
    oauth_ready: true,                 // OAuth /login + /callback are implemented
  });
}
