import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { gatherSymbols, processSymbol } from "@/lib/research-agent";
import { isIndia } from "@/lib/india-data";
import { prewarmPriceCache } from "@/lib/chart-data";
import { RISK_PROFILES } from "@/lib/risk-profiles";
import { verifyCronSecret } from "@/lib/auth/cron";
import { emitAlert } from "@/lib/alerts/emit";

export const dynamic = "force-dynamic";
// Bumped from 60 -> 150s: Theme Scout is now awaited inline (before
// gatherSymbols) instead of fired async, so its own AV/LLM round-trip now
// counts against this run's budget too.
export const maxDuration = 150;

// Called by Windows Task Scheduler. US run ~9 AM ET; India run ~6:15 AM ET (after
// the 15:30 IST / 06:00 ET NSE close). `?market=us|india` scopes the run to one
// market so each fires on its own market's schedule and only touches its own
// symbols. No param = legacy all-symbols behavior.
// curl -X POST "http://localhost:3000/api/agents/research/cron?market=india" -H "x-cron-secret: <CRON_SECRET>"
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const mktParam = new URL(req.url).searchParams.get("market");
  const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

  const supabase = createServiceClient();

  // Skip on weekends (both markets closed Sat/Sun).
  const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const dayOfWeek = nowET.getDay(); // 0=Sun, 6=Sat
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return NextResponse.json({ skipped: true, reason: "Weekend — market closed" });
  }
  // US holiday calendar only gates US runs — an India run must not be skipped on
  // a US holiday (and vice versa).
  if (marketScope !== "india") {
    const mmdd = `${String(nowET.getMonth() + 1).padStart(2, "0")}-${String(nowET.getDate()).padStart(2, "0")}`;
    const US_HOLIDAYS = ["01-01","01-20","02-17","04-18","05-26","06-19","07-04","09-01","11-27","12-25"]; // 2026 approx
    if (US_HOLIDAYS.includes(mmdd)) {
      return NextResponse.json({ skipped: true, reason: `US market holiday (${mmdd})` });
    }
  }
  // NSE holiday calendar — FIXED-DATE holidays only (Republic Day, Independence
  // Day, Gandhi Jayanti). Floating festival holidays (Holi, Diwali, Eid, etc.)
  // are NOT modeled here — they shift yearly and guessing wrong dates is worse
  // than not gating at all. On an unmodeled NSE holiday this still fires and
  // produces stale/no data; a proper fix needs a verified annual NSE holiday
  // calendar (API or manually-updated list), not a guess.
  if (marketScope === "india") {
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mmddIST = `${String(nowIST.getMonth() + 1).padStart(2, "0")}-${String(nowIST.getDate()).padStart(2, "0")}`;
    const NSE_FIXED_HOLIDAYS = ["01-26", "08-15", "10-02"]; // Republic Day, Independence Day, Gandhi Jayanti
    if (NSE_FIXED_HOLIDAYS.includes(mmddIST)) {
      return NextResponse.json({ skipped: true, reason: `NSE fixed-date holiday (${mmddIST})` });
    }
  }

  // Pause check — skip if app is paused
  const { data: cfg } = await supabase.from("strategy_config").select("app_paused").limit(1).single();
  if ((cfg as any)?.app_paused) {
    return NextResponse.json({ skipped: true, reason: "App is paused — research cron disabled" });
  }

  // Posture auto-revert (Part B) — resilient: absent columns pre-migration → no-op.
  try {
    const { data: postureCfg } = await supabase
      .from("strategy_config")
      .select("id, posture, posture_expires_at, base_risk_profile")
      .limit(1)
      .maybeSingle();
    if (postureCfg?.posture && postureCfg.posture_expires_at && new Date(postureCfg.posture_expires_at) <= new Date()) {
      const base = (postureCfg.base_risk_profile ?? "balanced") as keyof typeof RISK_PROFILES;
      await supabase.from("strategy_config").update({
        ...RISK_PROFILES[base], risk_profile: base, posture: null, posture_expires_at: null, base_risk_profile: null,
      } as any).eq("id", postureCfg.id);
      await supabase.from("decision_journal").insert({
        entry_type: "posture_expired",
        summary: `Posture ${postureCfg.posture} expired, reverted to ${base}`,
      } as any);
    }
  } catch { /* pre-migration schema — no-op */ }

  // Idempotency guard — a duplicate/manual re-trigger within 30 min shouldn't
  // re-run the pass. But it must be PER MARKET: a US run at 9 AM must not suppress
  // the India run, and vice-versa. agent_runs has no market column, so infer each
  // recent run's market from its symbols (any .NS/.BO → India) and only block when
  // a run for THIS market is in the window.
  const guardWindow = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: recentRuns } = await supabase
    .from("agent_runs")
    .select("id, status, started_at, symbols")
    .eq("agent_type", "research")
    .gte("started_at", guardWindow)
    .order("started_at", { ascending: false })
    .limit(5);
  const runMarket = (r: any): string =>
    (Array.isArray(r?.symbols) && r.symbols.some((s: string) => /\.(NS|BO)$/i.test(String(s)))) ? "india" : "us";
  const guardMarket = marketScope ?? "us";
  const recentRun = (recentRuns ?? []).find((r: any) => runMarket(r) === guardMarket);
  if (recentRun) {
    return NextResponse.json({
      skipped: true,
      reason: `Research (${guardMarket}) already ran (or is running) within the last 30 minutes — run ${(recentRun as any).id} started at ${(recentRun as any).started_at}`,
    });
  }

  // Theme Scout runs (and is awaited) BEFORE gatherSymbols so today's newly
  // discovered theme tickers land in the watchlist in time to be researched
  // THIS run, not tomorrow's. US-only (theme-scout has no India logic) — skip
  // on an India-scoped run so it doesn't fire twice a day.
  if (marketScope !== "india") {
    const appUrlEarly = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    try {
      const tsRes = await fetch(`${appUrlEarly}/api/agents/theme-scout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": process.env.CRON_SECRET ?? "" },
        signal: AbortSignal.timeout(45000),
      });
      if (!tsRes.ok) console.error(`[research-cron] Theme Scout failed inline (${tsRes.status}) — proceeding without today's new theme picks`);
    } catch (e) {
      // Fail-soft — a Theme Scout hiccup must never block research — but
      // silent failure here previously left zero signal that "0 signals
      // written" or a slow run was actually caused by Theme Scout timing out.
      console.error("[research-cron] Theme Scout timed out or errored inline — proceeding without today's new theme picks:", e instanceof Error ? e.message : e);
    }
  }

  const allEntries = await gatherSymbols(supabase);
  // Scope to the requested market: India run researches only .NS/.BO names; US run
  // only non-India. No param → everything (legacy).
  const entries = marketScope === "india" ? allEntries.filter(e => isIndia(e.symbol))
    : marketScope === "us" ? allEntries.filter(e => !isIndia(e.symbol))
    : allEntries;
  const batch = entries.map(e => e.symbol);

  if (entries.length === 0) {
    return NextResponse.json({ skipped: true, reason: `No ${marketScope ?? "any"}-market symbols to research (check market_focus).` });
  }

  const { data: runRow } = await supabase.from("agent_runs").insert({
    agent_type: "research",
    status: "running",
    market: marketScope ?? "us",
    symbols: batch,
    trigger_source: "scheduled",
  } as any).select().single();
  const runId = (runRow as any)?.id ?? null;

  // P1: create a universe snapshot before scoring so every decision_observations
  // row can be linked to the PIT universe. Fail-soft: missing table pre-137 → no-op.
  let universeSnapshotId: number | null = null;
  try {
    const { data: snapRow } = await supabase.from("universe_snapshots").insert({
      run_id: runId ? String(runId) : null,
      market: marketScope ?? "us",
      source: "mixed",   // holdings + screener + watchlist gathered together
      symbol_count: batch.length,
      symbols: batch,
    }).select("id").single();
    universeSnapshotId = (snapRow as any)?.id ?? null;
  } catch { /* pre-137 schema — no-op */ }

  // Parallel processing — RESEARCH_PARALLEL workers run concurrently so 42 symbols
  // finish in ceil(42/N) rounds instead of serially. Default 5 keeps well inside
  // the 150s maxDuration (42/5 rounds × ~8s each ≈ 72s). Raise carefully: AV free
  // tier is 5 req/min, but av-cache absorbs repeat calls so burst is rare.
  const concurrency = parseInt(process.env.RESEARCH_PARALLEL ?? "5");
  const results: any[] = new Array(entries.length);
  let idx = 0;
  async function worker() {
    while (idx < entries.length) {
      const i = idx++;
      const entry = entries[i];
      try {
        results[i] = await processSymbol(entry, supabase, universeSnapshotId);
      } catch (e) {
        results[i] = { symbol: entry.symbol, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));

  const ok = results.filter(r => !r.error).length;
  const errs = results.filter(r => r.error).length;

  // P1: compute cross-sectional rank for this run's universe and persist to
  // universe_snapshot_scores. Percentile rank = fraction of symbols scoring BELOW
  // this symbol (min-rank = 0 for lowest scorer, max = 1 for highest scorer).
  // Fail-soft: never blocks the cron response on a rank-write failure.
  if (universeSnapshotId) {
    try {
      const scored = results
        .filter(r => !r.error && typeof r.analystScore === "number")
        .map(r => ({ symbol: r.symbol as string, score: r.analystScore as number, obsId: (r.obsId ?? null) as number | null }));
      if (scored.length > 1) {
        const sorted = [...scored].sort((a, b) => a.score - b.score);
        const rankRows = scored.map(s => {
          const below = sorted.filter(x => x.score < s.score).length;
          return {
            universe_snapshot_id: universeSnapshotId,
            symbol: s.symbol,
            analyst_score: s.score,
            rank_pct: below / (scored.length - 1),  // 0 = lowest, 1 = highest
            decision_observation_id: s.obsId,
          };
        });
        await supabase.from("universe_snapshot_scores").insert(rankRows);
      }
    } catch (e) {
      console.error("[research-cron] universe_snapshot_scores write failed (non-blocking):", e instanceof Error ? e.message : e);
    }
  }

  if (runId) {
    await supabase.from("agent_runs").update({
      status: "done",
      signals_written: ok,
      result_summary: `cron: ${ok} signals, ${errs} failed | ${batch.join(",")}`,
      completed_at: new Date().toISOString(),
    } as any).eq("id", runId);
  }

  // Emit alerts for failures
  if (errs > 0) {
    const failedSymbols = results.filter(r => r.error).map(r => r.symbol).join(", ");
    await emitAlert({
      severity: errs === results.length ? "error" : "warn",
      category: "cron",
      title: `Research: ${errs} symbol${errs > 1 ? "s" : ""} failed`,
      detail: `Failed: ${failedSymbols}. ${ok} succeeded.`,
      auto_expire_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
  }
  if (ok === 0 && batch.length > 0) {
    await emitAlert({
      severity: "error",
      category: "cron",
      title: "Research cron produced 0 signals",
      detail: `Attempted ${batch.length} symbols, all failed. Check LLM keys and data APIs.`,
      auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
  }

  // Chain PaperTrader automatically after research completes — same market scope
  // so an India research run fills the ₹ pool, a US run the $ pool.
  let paperTradeResult: any = null;
  try {
    const ptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/api/agents/paper-trade${marketScope ? `?market=${marketScope}` : ""}`;
    const ptRes = await fetch(ptUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Service-to-service: pass cron secret so paper-trade can skip user auth if needed
        "x-cron-secret": process.env.CRON_SECRET ?? "",
      },
    });
    paperTradeResult = await ptRes.json();
  } catch (e) {
    paperTradeResult = { error: e instanceof Error ? e.message : String(e) };
  }

  // Pre-warm price_cache for researched symbols + benchmark ETFs (fire async, don't block response)
  const BENCHMARK_SYMBOLS = ["VOO", "QQQ", "SPY", "IWM", "XLK", "XLF", "XLE", "XLV", "XLI", "XLY", "XLC", "XLP", "XLU", "XLRE", "XLB"];
  const prewarmSymbols = [...new Set([...batch, ...BENCHMARK_SYMBOLS])];
  prewarmPriceCache(prewarmSymbols, supabase).catch(() => {});

  return NextResponse.json({
    success: true, processed: results.length, ok, errors: errs, symbols: batch,
    paperTrade: paperTradeResult,
  });
}
