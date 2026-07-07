import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreAccountSnapshot } from "@/lib/research-agent";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { queryRobinhoodAccount, mcpToolJson } from "@/lib/robinhood-mcp";

export const dynamic = "force-dynamic";
export const maxDuration = 100;

// Persist the MCP-fetched account snapshot to live_account_snapshots.
// Uses mcpToolJson (not regex) for safe parse of Robinhood's escaped MCP text.
// Stores against the active trading account, not the hardcoded read-only one.
async function refreshViaMcp(): Promise<{ ok: boolean; error?: string }> {
  const svc = createServiceClient();
  const { data: cfg } = await svc
    .from("strategy_config")
    .select("robinhood_mcp_enabled, active_account_us")
    .limit(1)
    .maybeSingle();
  if (!(cfg as any)?.robinhood_mcp_enabled) return { ok: false, error: "robinhood_mcp_enabled is off" };

  // Use the configured trading account — never the hardcoded read-only account.
  const tradingAccount: string = (cfg as any)?.active_account_us ?? "605420660";

  const res = await queryRobinhoodAccount();
  if (!res.ok) return { ok: false, error: res.error };
  try {
    // Parse accounts via mcpToolJson (handles Robinhood's escaped MCP text content).
    const acctRaw = res.data?.accounts?.content ?? res.data?.accounts;
    const posRaw = res.data?.positions?.content ?? res.data?.positions;

    const acctObj = mcpToolJson(acctRaw);
    const posObj = mcpToolJson(posRaw);

    // Account fields — try structured parse first, fall back to regex on the text.
    let equity: number | null = null;
    let buyingPower: number | null = null;
    let portfolioValue: number | null = null;

    if (acctObj) {
      // Robinhood MCP may return { accounts: [...] } or direct account fields.
      const acct =
        Array.isArray(acctObj?.accounts)
          ? acctObj.accounts.find((a: any) => String(a.account_number) === tradingAccount || !tradingAccount) ?? acctObj.accounts[0]
          : acctObj;
      equity = parseFloat(acct?.equity ?? acct?.portfolio_value) || null;
      buyingPower = parseFloat(acct?.buying_power) || null;
      portfolioValue = parseFloat(acct?.portfolio_value ?? acct?.equity) || null;
    } else {
      // Regex fallback on raw text (pre-mcpToolJson path).
      const text = typeof acctRaw === "string" ? acctRaw : JSON.stringify(acctRaw ?? "");
      const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };
      equity = num(/"(?:equity|portfolio_value)"\s*:\s*"?([\d.]+)"?/);
      buyingPower = num(/"buying_power"\s*:\s*"?([\d.]+)"?/);
      portfolioValue = num(/"portfolio_value"\s*:\s*"?([\d.]+)"?/);
    }

    // Positions — structured array preferred.
    let positionsJson: any = null;
    if (posObj) {
      positionsJson = Array.isArray(posObj?.positions) ? posObj.positions
        : Array.isArray(posObj?.results) ? posObj.results
        : Array.isArray(posObj) ? posObj
        : posRaw ?? null;
    } else {
      positionsJson = posRaw ?? null;
    }

    await svc.from("live_account_snapshots").upsert({
      account_id: tradingAccount,
      equity,
      buying_power: buyingPower,
      portfolio_value: portfolioValue,
      positions_json: positionsJson,
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
