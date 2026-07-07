import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreAccountSnapshot } from "@/lib/research-agent";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { queryRobinhoodAccount } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 100;

// Persist the MCP-fetched account snapshot to live_account_snapshots directly
// via the service client (NOT the loopback HTTP hop that ships CRON_SECRET to
// NEXT_PUBLIC_APP_URL). Parses accounts/positions defensively; on any shape it
// can't read, leaves the snapshot stale rather than writing garbage.
async function refreshViaMcp(): Promise<{ ok: boolean; error?: string }> {
  const svc = createServiceClient();
  const { data: cfg } = await svc.from("strategy_config").select("robinhood_mcp_enabled").limit(1).maybeSingle();
  if (!(cfg as any)?.robinhood_mcp_enabled) return { ok: false, error: "robinhood_mcp_enabled is off" };
  const res = await queryRobinhoodAccount();
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const acct = res.data?.accounts?.content ?? res.data?.accounts;
    const positions = res.data?.positions?.content ?? res.data?.positions;
    const asText = (v: any) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
    const acctStr = asText(acct);
    const num = (re: RegExp) => { const m = acctStr.match(re); return m ? Number(m[1]) : null; };
    await svc.from("live_account_snapshots").upsert({
      account_id: "965848641",
      equity: num(/"(?:equity|portfolio_value)"\s*:\s*"?([\d.]+)"?/),
      buying_power: num(/"buying_power"\s*:\s*"?([\d.]+)"?/),
      portfolio_value: num(/"portfolio_value"\s*:\s*"?([\d.]+)"?/),
      positions_json: positions ?? null,
      captured_at: new Date().toISOString(),
    }, { onConflict: "account_id" });
    return { ok: true };
  } catch (e) { return { ok: false, error: `snapshot parse/store error: ${String(e)}` }; }
}

// Standalone Robinhood live-account snapshot refresh. Previously fired
// automatically inside gatherSymbols() on every research run -- but it shells
// out to a local Claude Code CLI (lib/claude-exec.ts, PowerShell + claude.cmd)
// with Robinhood MCP access, which only exists on a Windows machine with
// Claude Code installed. Every invocation from Vercel/cloud cron threw
// immediately, silently (fire-and-forget), so this data never refreshed once
// research moved to the cloud.
//
// Decoupled so the user controls where this specific piece runs from,
// independent of where research/paper-trade/position-monitor run: register a
// LOCAL Windows Task Scheduler entry hitting this endpoint on its own
// schedule (needs a local server + Claude Code + Robinhood MCP configured),
// while cloud cron continues to own everything else. Not on the pg_cron
// schedule itself -- pg_cron/Vercel can call this endpoint, but the call
// would fail the same way execClaude always does outside a Windows+Claude
// Code environment.
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Route to the configured snapshot source: cloud MCP or local Claude-exec.
  const svc = createServiceClient();
  const { data: cfg } = await svc.from("strategy_config").select("live_account_source").limit(1).maybeSingle();
  const source = (cfg as any)?.live_account_source ?? "claude_exec";
  const result = source === "robinhood_mcp" ? await refreshViaMcp() : await fetchAndStoreAccountSnapshot();
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
