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
async function refreshViaMcp(): Promise<{ ok: boolean; error?: string; equity?: number | null; buying_power?: number | null; positions?: number }> {
  const svc = createServiceClient();
  const { data: cfg } = await svc
    .from("strategy_config")
    .select("robinhood_mcp_enabled, active_account_us")
    .limit(1)
    .maybeSingle();
  if (!(cfg as any)?.robinhood_mcp_enabled) return { ok: false, error: "robinhood_mcp_enabled is off" };

  // Use the configured trading account — never the hardcoded read-only account.
  const tradingAccount: string = (cfg as any)?.active_account_us ?? "605420660";

  const res = await queryRobinhoodAccount(tradingAccount);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    // Parse accounts via mcpToolJson (handles Robinhood's escaped MCP text content).
    const acctRaw = res.data?.accounts?.content ?? res.data?.accounts;
    const posRaw = res.data?.positions?.content ?? res.data?.positions;
    const portRaw = res.data?.portfolio?.content ?? res.data?.portfolio;

    const acctObj = mcpToolJson(acctRaw);
    const posObj = mcpToolJson(posRaw);
    const portObj = mcpToolJson(portRaw);

    // Account fields — try structured parse first, fall back to regex on the text.
    let equity: number | null = null;
    let buyingPower: number | null = null;
    let portfolioValue: number | null = null;

    // get_portfolio returns { data: { total_value, equity_value, cash, buying_power:{buying_power} } }.
    // total_value = live NAV (holdings + cash) — the authoritative account value.
    // equity_value is holdings-only; do NOT use it as NAV.
    const pd = portObj?.data ?? portObj;
    if (pd) {
      const pv = parseFloat(pd?.total_value) || null;
      if (pv) { equity = pv; portfolioValue = pv; }
      const bp = parseFloat(pd?.buying_power?.buying_power ?? pd?.buying_power) || null;
      if (bp) buyingPower = bp;
    }

    if (acctObj) {
      // Robinhood MCP may return { accounts: [...] } or direct account fields.
      const acct =
        Array.isArray(acctObj?.accounts)
          ? acctObj.accounts.find((a: any) => String(a.account_number) === tradingAccount || !tradingAccount) ?? acctObj.accounts[0]
          : acctObj;
      equity = equity ?? (parseFloat(acct?.equity ?? acct?.portfolio_value) || null);
      buyingPower = buyingPower ?? (parseFloat(acct?.buying_power) || null);
      portfolioValue = portfolioValue ?? (parseFloat(acct?.portfolio_value ?? acct?.equity) || null);
    } else if (equity == null) {
      // Regex fallback on raw text (pre-mcpToolJson path).
      const text = typeof acctRaw === "string" ? acctRaw : JSON.stringify(acctRaw ?? "");
      const num = (re: RegExp) => { const m = text.match(re); return m ? Number(m[1]) : null; };
      equity = num(/"(?:equity|portfolio_value)"\s*:\s*"?([\d.]+)"?/);
      buyingPower = num(/"buying_power"\s*:\s*"?([\d.]+)"?/);
      portfolioValue = num(/"portfolio_value"\s*:\s*"?([\d.]+)"?/);
    }

    // Positions — get_equity_positions returns { data: { positions: [...] } }; unwrap it
    // to the real array (symbol/quantity/average_buy_price per position). Never store the
    // raw {content:[{text}]} MCP wrapper.
    const posData = posObj?.data ?? posObj;
    const positionsJson: any =
      Array.isArray(posData?.positions) ? posData.positions
      : Array.isArray(posData?.results) ? posData.results
      : Array.isArray(posData) ? posData
      : Array.isArray(posObj?.positions) ? posObj.positions
      : Array.isArray(posObj) ? posObj
      : null;

    // Guard: a transient empty fetch must not overwrite a previously-good snapshot
    // with nulls (that's how the prior IBIT position + NAV got wiped during debugging).
    const posCount = Array.isArray(positionsJson) ? positionsJson.length : (positionsJson ? 1 : 0);
    if (equity == null && posCount === 0) {
      return { ok: false, error: "Robinhood returned no account value or positions — snapshot not overwritten (transient/empty fetch)" };
    }

    await svc.from("live_account_snapshots").upsert({
      account_id: tradingAccount,
      equity,
      buying_power: buyingPower,
      portfolio_value: portfolioValue,
      positions_json: positionsJson,
      captured_at: new Date().toISOString(),
    }, { onConflict: "account_id" });
    return { ok: true, equity, buying_power: buyingPower, positions: posCount };
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
