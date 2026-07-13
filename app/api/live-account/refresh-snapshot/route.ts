import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreAccountSnapshot } from "@/lib/research-agent";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";

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

  try {
    const accounts = await captureAllRobinhoodAccounts();
    const valid = accounts.filter(a => !a.error && a.accountId && a.accountId !== "unknown");
    const active = valid.find(a => a.accountId === tradingAccount);
    if (!active) {
      const reason = accounts.find(a => a.accountId === tradingAccount)?.error
        ?? accounts[0]?.error ?? `active account ${tradingAccount} was not returned by Robinhood MCP`;
      return { ok: false, error: `${reason} — existing snapshots preserved` };
    }
    const capturedAt = new Date().toISOString();
    const rows = valid.map(a => ({
      account_id: a.accountId!,
      equity: a.totalValue,
      buying_power: a.buyingPower ?? null,
      portfolio_value: a.totalValue,
      positions_json: a.holdings.map(h => ({
        symbol: h.symbol,
        qty: h.qty,
        quantity: String(h.qty),
        avg_price: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
        average_buy_price: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
        current_price: h.currentPrice,
      })),
      captured_at: capturedAt,
    }));
    const { error: upsertError } = await svc.from("live_account_snapshots").upsert(rows, { onConflict: "account_id" });
    if (upsertError) return { ok: false, error: `snapshot upsert failed: ${upsertError.message}` };

    // Accrue the durable daily equity curve (live_performance) — one row per
    // account per calendar day with real broker equity + that day's VOO close.
    // Robinhood exposes no account-value history, so this is the ONLY way we get
    // a true live-vs-VOO chart: build it forward, one snapshot at a time.
    // Best-effort — a benchmark/price hiccup must never fail the snapshot write.
    try {
      const day = capturedAt.slice(0, 10);
      let vooClose: number | null = null;
      const massiveKey = process.env.MASSIVE_API_KEY;
      if (massiveKey) {
        const r = await fetch(`https://api.massive.com/v2/aggs/ticker/VOO/prev?adjusted=true&apiKey=${massiveKey}`);
        if (r.ok) { const d = await r.json(); vooClose = d?.results?.[0]?.c ?? null; }
      }
      const perfRows = valid
        .filter(a => a.totalValue != null)
        .map(a => ({ account_id: a.accountId!, date: day, equity: a.totalValue, bench_nav: vooClose }));
      if (perfRows.length) {
        await svc.from("live_performance").upsert(perfRows, { onConflict: "account_id,date" });
      }
    } catch { /* never let the perf-curve write mask a good snapshot */ }

    return { ok: true, equity: active.totalValue, buying_power: active.buyingPower ?? null, positions: active.holdings.length };
  } catch (e) {
    return { ok: false, error: `snapshot capture/store error: ${String(e)}` };
  }

  /* Legacy single-account parser retained temporarily for rollback reference.

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

    // Guard: only overwrite the snapshot on a COMPLETE fetch — NAV present AND a positions
    // array parsed (an empty [] is a valid "no holdings" answer; null means the positions
    // call failed/rate-limited). A partial fetch must NOT clobber the prior consistent
    // snapshot, or G3 would read a fresh captured_at with a stale/empty book and approve
    // concentration it should block. positionsJson is an array or null by construction here.
    const positionsOk = Array.isArray(positionsJson);
    const posCount = positionsOk ? positionsJson.length : 0;
    if (equity == null || !positionsOk) {
      return { ok: false, error: "Robinhood fetch incomplete (missing account value or positions) — snapshot preserved, not overwritten" };
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
  } catch (e) { return { ok: false, error: `snapshot parse/store error: ${String(e)}` }; } */
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
