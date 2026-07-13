import { NextRequest, NextResponse } from "next/server";
import { fetchAndStoreAccountSnapshot } from "@/lib/research-agent";
import { verifyCronSecret } from "@/lib/auth/cron";
import { createServiceClient } from "@/lib/supabase/service";
import { captureAllRobinhoodAccounts } from "@/lib/robinhood-mcp";
import { MCP_BROKERS } from "@/lib/brokers/mcp-registry";
import { captureAccounts, hasToken } from "@/lib/brokers/mcp-driver";
import { getKiteHoldings, getKiteMargins, getKiteProfile } from "@/lib/kite";
import { fetchIndiaQuote } from "@/lib/india-data";

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
      broker: "robinhood",
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

    // SAFE auto-REMOVE (pruning) — delete only Robinhood's OWN accounts that RH
    // no longer returns, and ONLY because this capture SUCCEEDED with >=1 valid
    // account. valid.length >= 1 is guaranteed here (we returned above if the
    // active account was missing, and `valid` includes it), but assert it
    // explicitly so an empty/failed capture can NEVER mass-delete the rows the
    // kill switch reads for its NAV baseline. live_performance is left intact
    // (append-only equity curve).
    const keepIds = valid.map(a => a.accountId!);
    if (keepIds.length >= 1) {
      const inList = keepIds.map(id => `"${String(id).replace(/"/g, '""')}"`).join(",");
      const { data: pruned, error: pruneErr } = await svc
        .from("live_account_snapshots")
        .delete()
        .eq("broker", "robinhood")
        .not("account_id", "in", `(${inList})`)
        .select("account_id");
      if (pruneErr) {
        console.error(`[refresh-snapshot] robinhood prune failed (non-fatal): ${pruneErr.message}`);
      } else if (pruned?.length) {
        for (const p of pruned) console.log(`[refresh-snapshot] pruned stale robinhood account_id=${(p as any).account_id}`);
      }
    }

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
// Capture every CONNECTED registry MCP broker (Webull, and future ones) into the
// live account book — ADDITIVE to Robinhood, and CLOUD-native (OAuth token in the
// vault, no local machine). Auto-ADD: a newly-returned account just upserts, so
// opening an account at the broker makes it appear on the next refresh.
// Auto-REMOVE (pruning) IS done here, SAFELY: after a broker captures >=1 valid
// account, its own stale rows (broker=cfg.id, account_id not in the captured set)
// are deleted — never on a failed/empty capture, and never across brokers, so a
// broker outage can't wipe the kill-switch NAV baseline. Best-effort per broker;
// one broker failing (or its prune failing) never blocks another or Robinhood.
async function refreshRegistryBrokers(): Promise<{ broker: string; ok: boolean; accounts: number; error?: string }[]> {
  const svc = createServiceClient();
  const out: { broker: string; ok: boolean; accounts: number; error?: string }[] = [];
  const capturedAt = new Date().toISOString();
  const day = capturedAt.slice(0, 10);
  let vooClose: number | null = null;
  const massiveKey = process.env.MASSIVE_API_KEY;
  if (massiveKey) {
    try {
      const r = await fetch(`https://api.massive.com/v2/aggs/ticker/VOO/prev?adjusted=true&apiKey=${massiveKey}`);
      if (r.ok) { const d = await r.json(); vooClose = d?.results?.[0]?.c ?? null; }
    } catch { /* bench optional */ }
  }
  for (const cfg of Object.values(MCP_BROKERS)) {
    try {
      if (!(await hasToken(svc, cfg))) { out.push({ broker: cfg.id, ok: false, accounts: 0, error: "not connected" }); continue; }
      const accts = await captureAccounts(cfg);
      const valid = accts.filter(a => !a.error && a.accountId && a.accountId !== "unknown" && a.totalValue != null);
      if (!valid.length) { out.push({ broker: cfg.id, ok: false, accounts: 0, error: accts[0]?.error ?? "no valid accounts" }); continue; }
      const rows = valid.map(a => ({
        account_id: a.accountId!,
        broker: cfg.id,
        equity: a.totalValue,
        buying_power: a.buyingPower ?? null,
        portfolio_value: a.totalValue,
        position_count: a.holdings.length,
        nickname: cfg.label,
        positions_json: a.holdings.map(h => ({
          symbol: h.symbol, qty: h.qty, quantity: String(h.qty),
          avg_price: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
          average_buy_price: h.costBasis != null && h.qty > 0 ? h.costBasis / h.qty : null,
          current_price: h.currentPrice,
        })),
        captured_at: capturedAt,
      }));
      const { error: upErr } = await svc.from("live_account_snapshots").upsert(rows, { onConflict: "account_id" });
      if (upErr) { out.push({ broker: cfg.id, ok: false, accounts: 0, error: upErr.message }); continue; }

      // SAFE auto-REMOVE (pruning) — delete only THIS broker's own accounts that
      // it no longer returns, gated on a successful capture with >=1 valid
      // account (guaranteed by the `!valid.length` guard above, re-asserted here
      // so a partial/empty capture can never mass-delete near the kill-switch NAV
      // baseline). Scoped by broker=cfg.id; other brokers' rows are untouched.
      // live_performance history is intentionally left intact (append-only curve).
      const keepIds = valid.map(a => a.accountId!);
      if (keepIds.length >= 1) {
        const inList = keepIds.map(id => `"${String(id).replace(/"/g, '""')}"`).join(",");
        const { data: pruned, error: pruneErr } = await svc
          .from("live_account_snapshots")
          .delete()
          .eq("broker", cfg.id)
          .not("account_id", "in", `(${inList})`)
          .select("account_id");
        if (pruneErr) {
          console.error(`[refresh-snapshot] ${cfg.id} prune failed (non-fatal): ${pruneErr.message}`);
        } else if (pruned?.length) {
          for (const p of pruned) console.log(`[refresh-snapshot] pruned stale ${cfg.id} account_id=${(p as any).account_id}`);
        }
      }

      const perfRows = valid.map(a => ({ account_id: a.accountId!, date: day, equity: a.totalValue, bench_nav: vooClose }));
      await svc.from("live_performance").upsert(perfRows, { onConflict: "account_id,date" }).then(undefined, () => {});
      out.push({ broker: cfg.id, ok: true, accounts: valid.length });
    } catch (e) {
      out.push({ broker: cfg.id, ok: false, accounts: 0, error: String(e) });
    }
  }
  return out;
}

// Accrue the durable India live-equity curve from Zerodha Kite — the exact
// analogue of the US live_performance forward-build, but INR + NIFTF benchmark.
// Kite exposes no account-value history, so we build it one day at a time:
//   NAV = margins.equity.net (cash) + Σ(last_price × qty) over live holdings
//   bench = ^NSEI close (same index the paper India chart uses)
// Writes ONLY live_performance (market='india'), never live_account_snapshots —
// so the Kite account can never leak into the US account chips or the US
// kill-switch NAV baseline. Fully fail-soft: a stale daily token or any read
// error just skips the day; it must never fail the US/registry refresh.
async function refreshKite(): Promise<{ ok: boolean; equity?: number; positions?: number; error?: string }> {
  const svc = createServiceClient();
  try {
    const [prof, hold, marg] = await Promise.all([
      getKiteProfile(svc),
      getKiteHoldings(svc),
      getKiteMargins(svc),
    ]);
    if (!prof.ok) return { ok: false, error: `kite profile: ${prof.error}` };
    if (!hold.ok) return { ok: false, error: `kite holdings: ${hold.error}` };
    if (!marg.ok) return { ok: false, error: `kite margins: ${marg.error}` };

    const holdings: any[] = Array.isArray(hold.data) ? hold.data : [];
    const holdingsValue = holdings.reduce((s, h) => s + (Number(h.last_price ?? 0) * Number(h.quantity ?? 0)), 0);
    const nav = Number(marg.equityNet ?? 0) + holdingsValue;
    if (!Number.isFinite(nav)) return { ok: false, error: "computed India NAV is not finite" };

    // ^NSEI close for the day (fail-soft — a null bench is a valid row, the
    // chart just skips the benchmark line for that point).
    let niftyClose: number | null = null;
    try {
      const q = await fetchIndiaQuote("^NSEI");
      const px = (q as any)?.price ?? (q as any)?.close ?? null;
      niftyClose = typeof px === "number" && px > 0 ? px : null;
    } catch { /* bench optional */ }

    const day = new Date().toISOString().slice(0, 10);
    const { error: upErr } = await svc.from("live_performance").upsert(
      {
        account_id: prof.userId!,
        date: day,
        equity: nav,
        bench_nav: niftyClose,
        market: "india",
        currency: "INR",
        broker: "kite",
      },
      { onConflict: "account_id,date" },
    );
    if (upErr) return { ok: false, error: `live_performance upsert: ${upErr.message}` };
    return { ok: true, equity: nav, positions: holdings.length };
  } catch (e) {
    return { ok: false, error: `kite accrual error: ${String(e)}` };
  }
}

export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Route to the configured snapshot source: cloud MCP or local Claude-exec.
  const svc = createServiceClient();
  const { data: cfg } = await svc.from("strategy_config").select("live_account_source").limit(1).maybeSingle();
  const source = (cfg as any)?.live_account_source ?? "claude_exec";
  const result = source === "robinhood_mcp" ? await refreshViaMcp() : await fetchAndStoreAccountSnapshot();
  // Also refresh every connected cloud MCP broker (Webull, etc.) — independent of
  // Robinhood, so it runs even when RH is off/local.
  const registry = await refreshRegistryBrokers();
  // Accrue the India (Kite) live-equity curve — independent + fail-soft, so a
  // stale Kite token never affects the US/registry result.
  const kite = await refreshKite();
  const anyOk = result.ok || registry.some(r => r.ok) || kite.ok;
  return NextResponse.json({ ...result, registry, kite }, { status: anyOk ? 200 : 500 });
}
