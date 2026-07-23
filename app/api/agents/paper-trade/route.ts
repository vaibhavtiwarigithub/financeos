import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isSymbolBlocked } from "@/lib/trading/symbol-policy";
import { getQuote, getBatchQuotes, computeFillPrice } from "@/lib/data/quotes";
import { fetchIndiaQuote } from "@/lib/india-data";
import { checkKillSwitches } from "@/lib/kill-switches";
import { constructPortfolio, DEFAULT_LIMITS, type BookPosition } from "@/lib/portfolio/constructor";
import { estimateDailyVolPct } from "@/lib/portfolio/inputs";
import { predictPWin } from "@/lib/validation/calibration";
import { positionSizePct as kellyPositionSizePct } from "@/lib/risk/sizing";
import { computeAllocation } from "@/lib/allocation/allocator";
import { getGlobalMaeMfePercentiles } from "@/lib/risk/percentiles";
import { loadChampionGenome, type ResolvedGenome } from "@/lib/validation/genome-live";
import { verifyCronSecret } from "@/lib/auth/cron";
import { loadTradingMandate, mandateSnapshot, resolveHorizonDays, type TradingMandate } from "@/lib/trading-mandate";
import { isPaused, isTradingEnabled } from "@/lib/market-controls";
import { recordCapitalRotationShadow, executeCapitalRotationPaper } from "@/lib/trading/capital-rotation";
import { selectBestPaperSignals } from "@/lib/trading/paper-signal-selection";
import { canOpenPaperName } from "@/lib/trading/paper-entry-policy";
import { paperPerformanceTruth } from "@/lib/paper-nav";
import { bindTradePrices, resolveExecutionRiskReward } from "@/lib/trading/trade-plan";
import { isMarketSessionOpen } from "@/lib/trading/market-calendar";

// Research Journal — one stage event per signal per pipeline stage. Fail-soft:
// never blocks the actual trading decision it's describing.
async function logStage(supabase: any, args: { signal_id: string | null; symbol: string | null; market: string; stage: string; outcome: string; reason?: string; detail?: any }) {
  try {
    await supabase.from("pipeline_stage_events").insert({
      signal_id: args.signal_id, symbol: args.symbol, market: args.market,
      stage: args.stage, outcome: args.outcome, reason: args.reason ?? null, detail: args.detail ?? null,
    });
  } catch { /* fail-soft — pre-migration schema or transient error */ }
}

// PaperTrader: fills virtual long-only trades from qualifying signals.
//
// MULTI-MARKET (Phase 4): each market (us | india) has its OWN paper pool in its
// OWN currency (US = USD, India = INR). A signal is filled into its market's pool
// off that market's price source — US via getQuote (AV/Robinhood), India via
// Yahoo .NS. NAV/performance are computed PER MARKET; currencies are never summed.
// Guarded/dormant until migration 057 lands: if there's no `market` column or no
// India pool, this behaves exactly as the old US-only path.
//
// Prices are real (never LLM-estimated). Long-only: only direction="long".

export async function POST(req: NextRequest) {
  // Hoisted so the catch can finalize the agent_runs row (else a throw leaves it
  // stuck 'running' forever — the zombie-run failure mode this route caused).
  const supabase = createServiceClient();
  let runId: string | null = null;
  try {
    const isCron = verifyCronSecret(req);

    // Optional ?market=us|india — scope a run to one pool (India cron fills only
    // the ₹ pool, US cron only the $ pool). No param = all active markets.
    const mktParam = new URL(req.url).searchParams.get("market");
    const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: cfg } = await supabase
      .from("strategy_config")
      .select("score_threshold, position_size_pct, stop_loss_pct, target_pct, exit_hysteresis, max_gross_exposure_pct, max_sector_exposure_pct, max_name_exposure_pct, max_portfolio_vol_pct, max_avg_pairwise_corr, max_order_notional_usd_paper, max_order_notional_inr_paper, max_daily_notional_usd_paper, max_daily_notional_inr_paper")
      .limit(1)
      .single();
    let maxPerSector = 3;
    try {
      const { data: capRow } = await supabase.from("strategy_config").select("max_positions_per_sector").limit(1).single();
      if ((capRow as any)?.max_positions_per_sector != null) maxPerSector = Number((capRow as any).max_positions_per_sector);
    } catch { /* column not present yet — keep default 3 */ }

    const positionSizePct = (cfg as any)?.position_size_pct ?? 10;
    // Paper order caps (per market, scaled to paper NAV). null → not enforced.
    const perTradeCapUsdPaper = (cfg as any)?.max_order_notional_usd_paper ?? null;
    const perTradeCapInrPaper = (cfg as any)?.max_order_notional_inr_paper ?? null;
    const dailyCapUsdPaper = (cfg as any)?.max_daily_notional_usd_paper ?? null;
    const dailyCapInrPaper = (cfg as any)?.max_daily_notional_inr_paper ?? null;

    const { data: runRow } = await supabase.from("agent_runs").insert({
      agent_type: "paper_trader", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
      market: marketScope,
    } as any).select().single();
    runId = (runRow as any)?.id ?? null;
    const finishSkippedRun = async (summary: string) => {
      if (!runId) return;
      await supabase.from("agent_runs").update({
        status: "done", signals_written: 0, result_summary: summary,
        completed_at: new Date().toISOString(), tokens_input: 0,
        tokens_output: 0, claude_calls: 0,
      } as any).eq("id", runId);
    };

    // ── Pools per market ──────────────────────────────────────────────────────
    // One paper_portfolio row per market. Pre-057 there's a single row with no
    // `market` column → treated as the US pool. India appears once 057 seeds it.
    const { data: poolRows } = await supabase.from("paper_portfolio").select("*");
    const hasMarketCol = !!poolRows?.[0] && Object.prototype.hasOwnProperty.call(poolRows[0], "market");
    const poolByMarket = new Map<string, any>();
    for (const p of (poolRows ?? []) as any[]) poolByMarket.set(String(p.market ?? "us"), p);
    if (!poolByMarket.has("us")) {
      const { data: newP } = await supabase.from("paper_portfolio").insert({ cash_balance: 10000, nav: 10000 }).select().single();
      if (newP) poolByMarket.set("us", newP);
    }
    if (!poolByMarket.has("us")) {
      throw new Error("No paper portfolio found");
    }
    let activeMarkets = [...poolByMarket.keys()]; // 'us' always; 'india' when 057 applied
    if (marketScope) activeMarkets = activeMarkets.filter(m => m === marketScope); // scoped cron run

    // Paper fills model executable market orders, so they must happen during the
    // exchange's regular session. This also makes fixed-UTC cron drift fail closed
    // across EDT/EST changes and prevents a manually-triggered holiday fill.
    const sessionBlocks: Record<string, string> = {};
    for (const m of activeMarkets) {
      if (!isMarketSessionOpen(m)) sessionBlocks[m] = "outside_regular_session";
    }
    activeMarkets = activeMarkets.filter((m) => !sessionBlocks[m]);
    if (activeMarkets.length === 0) {
      await finishSkippedRun(`Paper entries skipped outside regular market session: ${JSON.stringify(sessionBlocks)}`);
      return NextResponse.json({ skipped: true, reason: "Outside regular market session", markets: sessionBlocks });
    }

    // Both controls are latched operator/risk controls. A fresh kill-switch
    // calculation returning safe must never bypass a prior manual/automatic
    // trading disable. Evaluate each market independently so one can continue.
    const controlBlocks: Record<string, string> = {};
    for (const m of activeMarkets) {
      if (await isPaused(supabase, m)) controlBlocks[m] = "paused";
      else if (!(await isTradingEnabled(supabase, m))) controlBlocks[m] = "trading_disabled";
    }
    activeMarkets = activeMarkets.filter((m) => !controlBlocks[m]);
    if (activeMarkets.length === 0) {
      await finishSkippedRun(`Paper entries disabled by market controls: ${JSON.stringify(controlBlocks)}`);
      return NextResponse.json({ skipped: true, reason: "Paper entries disabled by market controls", markets: controlBlocks });
    }

    // Kill-switches are evaluated PER MARKET (each on its own currency's NAV/
    // drawdown/accuracy). A tripped market is skipped; the others still fill.
    const ksByMarket: Record<string, { safe: boolean; reason?: string; tripped?: string }> = {};
    for (const m of activeMarkets) ksByMarket[m] = await checkKillSwitches(supabase, { market: m, book: "paper" });
    activeMarkets = activeMarkets.filter(m => ksByMarket[m].safe);
    if (activeMarkets.length === 0) {
      const first = Object.values(ksByMarket)[0];
      await finishSkippedRun(first?.reason ?? "All markets kill-switched");
      return NextResponse.json({ skipped: true, reason: first?.reason ?? "All markets kill-switched", tripped: first?.tripped });
    }

    // The per-market mandate is the canonical entry policy. strategy_config's
    // legacy global threshold is display/back-compat only and must not loosen a
    // US or India mandate.
    const mandateByMarket = new Map<string, TradingMandate>();
    for (const m of activeMarkets) {
      mandateByMarket.set(m, await loadTradingMandate(supabase, m as "us" | "india"));
    }

    // ── Market-local trading-day freshness ───────────────────────────────────
    // A signal only fills on the same market-local calendar day it was written.
    // Older pending long signals are EXPIRED (never filled) — this is what makes
    // the standalone paper-trade crons safe: a cron that wakes to a backlog of
    // 10-day-old pending signals must not open those stale trades. Cutoff is the
    // market-local day start (America/New_York US, Asia/Kolkata India), DST-safe.
    const cutoffByMarket = new Map<string, string>();
    for (const m of activeMarkets) {
      const { data: cut } = await supabase.rpc("market_trading_day_start", { p_market: m });
      // Fall back to a 24h window if the helper is somehow unavailable — still
      // freshness-guarded, just not calendar-aligned (fail-safe, not fail-open).
      cutoffByMarket.set(m, (cut as unknown as string) ?? new Date(Date.now() - 24 * 3600_000).toISOString());
    }

    // ── Qualifying signals across active markets ─────────────────────────────
    // India signals only get pulled when the India pool exists (hasMarketCol +
    // seeded). Freshness is enforced IN the query (not post-filtered) so stale
    // high-score signals can't crowd fresh ones out of the limit window.
    const signals: any[] = [];
    let expiredTotal = 0;
    for (const m of activeMarkets) {
      const cutoff = cutoffByMarket.get(m)!;
      const entryThreshold = mandateByMarket.get(m)?.score_threshold ?? 60;
      // Expire this market's stale pending long signals (older than today's open).
      let expQ = supabase.from("agent_signals").update({ status: "expired" })
        .eq("status", "pending").eq("direction", "long").lt("created_at", cutoff);
      expQ = hasMarketCol ? expQ.eq("market", m) : expQ.neq("asset_class", "india");
      const { data: expd, error: expireError } = await expQ.select("id");
      if (expireError) throw new Error(`stale signal expiry failed (${m}): ${expireError.message}`);
      const nExp = expd?.length ?? 0;
      expiredTotal += nExp;
      if (nExp > 0) await logStage(supabase, { signal_id: null, symbol: null, market: m, stage: "freshness", outcome: "expired", reason: `${nExp} stale pending long signal(s) expired (older than ${m}-local ${cutoff})`, detail: { cutoff, count: nExp } });

      // Fetch only fresh (same-trading-day) pending long candidates.
      let selQ = supabase.from("agent_signals").select("*", { count: "exact" })
        .eq("status", "pending").eq("direction", "long")
        .gte("analyst_score", entryThreshold).gte("created_at", cutoff)
        // Positive session proof: weekend catch-up scores are useful research
        // evidence but are never fill candidates until a fresh session run.
        .eq("session_validated", true)
        // Positive allowlist: ONLY the versioned deterministic source is fill-eligible.
        // A negative filter (is.null OR neq llm_advisory) failed OPEN — it admitted
        // null/unknown score_source, so any untagged signal could be traded.
        .eq("score_source", "deterministic_v1")
        .order("analyst_score", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(1000);
      selQ = hasMarketCol ? selQ.eq("market", m) : selQ.neq("asset_class", "india");
      const { data, error, count } = await selQ;
      if (error) throw new Error(`paper signal query failed (${m}): ${error.message}`);
      if ((count ?? 0) > (data?.length ?? 0)) {
        throw new Error(`paper signal cohort truncated (${m}): ${data?.length ?? 0}/${count}`);
      }
      if (data) signals.push(...data);
    }

    // Dedup: research runs 3x/day, stacking duplicate pending rows per symbol.
    // Keep only the highest-scoring signal per (symbol, market); ties → most recent.
    if (signals.length > 0) {
      const selected: any[] = [];
      const duplicateIds: string[] = [];
      for (const market of activeMarkets) {
        const marketRows = signals.filter(signal => {
          const rowMarket = hasMarketCol
            ? String(signal.market ?? (signal.asset_class === "india" ? "india" : "us"))
            : "us";
          return rowMarket === market;
        });
        const result = selectBestPaperSignals(
          marketRows,
          market as "us" | "india",
          hasMarketCol ? 10 : 5,
        );
        selected.push(...result.selected);
        duplicateIds.push(...result.duplicateIds);
      }
      if (duplicateIds.length > 0) {
        const { error } = await supabase.from("agent_signals")
          .update({ status: "superseded" })
          .in("id", duplicateIds)
          .eq("status", "pending");
        if (error) throw new Error(`paper signal supersession failed: ${error.message}`);
      }
      signals.length = 0;
      signals.push(...selected);
      signals.sort((a, b) => Number(b.analyst_score) - Number(a.analyst_score));
    }

    // Tradable-universe policy: drop leveraged/inverse ETFs + owner-blocklisted
    // symbols BEFORE filling, so they never become paper positions (paper fills
    // do not pass through the live execution gateway).
    if (signals.length > 0) {
      const kept: any[] = [];
      for (const s of signals) {
        const pol = await isSymbolBlocked(supabase, s.symbol, (s.market ?? "us") as "us" | "india");
        if (!pol.blocked) kept.push(s);
      }
      signals.length = 0;
      signals.push(...kept);
    }

    if (signals.length === 0) {
      const thresholds = Object.fromEntries([...mandateByMarket].map(([m, mandate]) => [m, mandate.score_threshold]));
      if (runId) await supabase.from("agent_runs").update({ status: "done", signals_written: 0, result_summary: `No fresh qualifying long signals for market mandate threshold(s) ${JSON.stringify(thresholds)}. ${expiredTotal} stale expired.`, completed_at: new Date().toISOString() } as any).eq("id", runId);
      return NextResponse.json({ skipped: true, reason: "No fresh qualifying long signals for market mandate threshold", thresholds, expired: expiredTotal });
    }

    const filled: any[] = [];
    const skipped: any[] = [];
    const rotationsThisRun = new Map<string, number>(); // market-local; caps never cross-consume

    // Sector cap is market-local. US sector occupancy must never block an India
    // name (or vice versa); the books and currencies are independent.
    const { data: openPos } = await supabase.from("paper_positions").select("symbol, sector, qty, avg_cost, market, position_role");
    const sectorCountByMarket = new Map<string, Record<string, number>>();
    for (const p of (openPos ?? []) as any[]) {
      if (!p.sector) continue;
      const m = hasMarketCol ? String(p.market ?? "us") : "us";
      const counts = sectorCountByMarket.get(m) ?? {};
      counts[p.sector] = (counts[p.sector] ?? 0) + 1;
      sectorCountByMarket.set(m, counts);
    }
    const openAlphaNamesByMarket = new Map<string, Set<string>>();
    for (const m of activeMarkets) openAlphaNamesByMarket.set(m, new Set());
    for (const p of (openPos ?? []) as any[]) {
      if ((p.position_role ?? "alpha") !== "alpha") continue;
      const m = hasMarketCol ? String(p.market ?? "us") : "us";
      const names = openAlphaNamesByMarket.get(m) ?? new Set<string>();
      names.add(String(p.symbol).toUpperCase());
      openAlphaNamesByMarket.set(m, names);
    }

    // Portfolio Constructor: per-market book (name/sector/gross/vol/correlation
    // budgeting — see lib/portfolio/constructor.ts). Human-set limits from
    // strategy_config, falling back to DEFAULT_LIMITS when unset/pre-069.
    const portfolioLimits = {
      maxGrossExposurePct: (cfg as any)?.max_gross_exposure_pct ?? DEFAULT_LIMITS.maxGrossExposurePct,
      maxSectorExposurePct: (cfg as any)?.max_sector_exposure_pct ?? DEFAULT_LIMITS.maxSectorExposurePct,
      maxNameExposurePct: (cfg as any)?.max_name_exposure_pct ?? DEFAULT_LIMITS.maxNameExposurePct,
      maxPortfolioVolPct: (cfg as any)?.max_portfolio_vol_pct ?? DEFAULT_LIMITS.maxPortfolioVolPct,
      maxAvgPairwiseCorr: (cfg as any)?.max_avg_pairwise_corr ?? DEFAULT_LIMITS.maxAvgPairwiseCorr,
    };
    const bookByMarket = new Map<string, BookPosition[]>();
    const constructorNavByMarket = new Map<string, number>();
    // Asset-allocation → sizing wire (SHIPPED OFF: computeAllocation returns null
    // unless strategy_config.allocation_enabled=true). When on, the deterministic
    // equity-sleeve target for a market TIGHTENS that market's gross-equity cap in
    // the Portfolio Constructor — e.g. a risk_off regime lowers the equity target,
    // so new equity buys are capped sooner and cash builds. It only ever SHRINKS
    // the gross cap (min with the configured limit), never raises it, and touches
    // no other gate. Default off = zero behaviour change.
    const allocEquityCapByMarket = new Map<string, number>();
    for (const m of activeMarkets) {
      const pool = poolByMarket.get(m);
      const mktPositions = (openPos ?? []).filter((p: any) => (hasMarketCol ? (p.market ?? "us") : "us") === m);
      const holdingsValue = mktPositions.reduce((s: number, p: any) => s + Number(p.qty ?? 0) * Number(p.avg_cost ?? 0), 0);
      const nav = (pool?.cash_balance ?? 0) + holdingsValue;
      constructorNavByMarket.set(m, nav > 0 ? nav : (pool?.cash_balance ?? 1));
      bookByMarket.set(m, mktPositions.map((p: any) => ({
        symbol: p.symbol, sector: p.sector ?? null,
        valuePct: nav > 0 ? (Number(p.qty ?? 0) * Number(p.avg_cost ?? 0) / nav) * 100 : 0,
        beta: null, dailyVol: null,
      })));
      try {
        const alloc = await computeAllocation(supabase, m as "us" | "india");
        const equity = alloc?.find(s => s.sleeve === "equity");
        if (equity && Number.isFinite(equity.targetPct) && equity.targetPct > 0) {
          allocEquityCapByMarket.set(m, equity.targetPct);
        }
      } catch { /* allocation is advisory — never break paper sizing */ }
    }
    async function resolveSector(sym: string, packetId: string | null): Promise<string | null> {
      try {
        const q = packetId
          ? supabase.from("research_packets").select("raw_data").eq("id", packetId).maybeSingle()
          : supabase.from("research_packets").select("raw_data").eq("symbol", sym).order("created_at", { ascending: false }).limit(1).maybeSingle();
        const { data } = await q;
        const sec = (data as any)?.raw_data?._scores?.evidence?.fundamental?.sector;
        return typeof sec === "string" && sec.length > 0 ? sec : null;
      } catch { return null; }
    }

    // Resolve a signal's market + currency + a real fill price from the right source.
    async function priceFor(signal: any, market: string): Promise<
      | { ok: true; price: number; fillPrice: number; source: string; retrievedAt: string; bid: number | null; ask: number | null; spread: number }
      | { ok: false; reason: string }
    > {
      if (market === "india") {
        const q = await fetchIndiaQuote(signal.symbol); // INR, free Yahoo .NS
        if (!q || q.price <= 0) return { ok: false, reason: "price_unavailable" };
        const fillPrice = parseFloat((q.price * 1.0005).toFixed(2)); // +0.05% slippage
        return { ok: true, price: q.price, fillPrice, source: "yahoo_india", retrievedAt: new Date().toISOString(), bid: null, ask: null, spread: 0.0005 };
      }
      const quote = await getQuote(signal.symbol, supabase);
      if (quote.source === "unavailable" || quote.price <= 0) return { ok: false, reason: "price_unavailable" };
      const fillPrice = computeFillPrice(quote);
      return { ok: true, price: quote.price, fillPrice, source: quote.source, retrievedAt: quote.retrievedAt, bid: quote.bid, ask: quote.ask, spread: fillPrice / quote.price - 1 };
    }

    // Insert with a resilient retry that strips OPTIONAL columns ONLY when the DB
    // actually reports an undefined column (pre-migration). A transient/constraint
    // error must NOT cause us to strip `market` and silently record an India row
    // as US — in that case we surface the error and skip the fill.
    const isUndefinedColumn = (err: any): boolean => {
      if (!err) return false;
      const code = String(err.code ?? "");
      return code === "42703" || code === "PGRST204" ||
        /column .* does not exist|could not find the '.*' column/i.test(String(err.message ?? ""));
    };
    async function insertOptional(table: string, row: Record<string, any>, optionalCols: string[], selectCols?: string):
      Promise<{ data?: any; error?: any }> {
      const attempt = { ...row };
      // At most optionalCols.length+1 tries: strip one missing optional col each time.
      for (let i = 0; i <= optionalCols.length; i++) {
        const r = selectCols
          ? await supabase.from(table).insert(attempt).select(selectCols).single()
          : await supabase.from(table).insert(attempt);
        if (!r.error) return r;
        if (!isUndefinedColumn(r.error)) return r; // real error — do NOT strip market
        const named = optionalCols.find(c => String(r.error.message ?? "").includes(`'${c}'`) || String(r.error.message ?? "").includes(` ${c} `));
        const toStrip = named ?? optionalCols.find(c => c in attempt);
        if (toStrip && toStrip in attempt) delete attempt[toStrip]; else return r;
      }
      return { error: { message: "exhausted optional-column retries" } };
    }

    // Phase 2: calibrated conviction-scaled sizing + dynamic MAE/MFE-percentile
    // R:R, per market. Both are OPTIONAL — absent until model_artifacts/enough
    // observation_labels exist (needs 60+ matured labels), so this ships dormant
    // and degrades to the existing flat positionSizePct + profile stop/target.
    const pwinModelByMarket = new Map<string, import("@/lib/validation/calibration").CalibrationCoefficients | null>();
    const maeMfeByMarket = new Map<string, Awaited<ReturnType<typeof import("@/lib/risk/percentiles").getGlobalMaeMfePercentiles>>>();
    // Build 1 (genome as live control): the promoted champion's genome now
    // governs the exit horizon + MAE/MFE percentiles used to derive dynamic
    // stops/targets, and the Kelly cap/floor used to size. loadChampionGenome
    // returns DEFAULT_GENOME (horizon 10, stop p25, target p75, cap 10, floor 2)
    // when no genome-bearing champion exists — the exact values used before this
    // wiring — so a legacy/genome-less market is byte-for-byte unchanged.
    const genomeByMarket = new Map<string, ResolvedGenome>();
    const horizonByMarket = new Map<string, number>();
    for (const m of activeMarkets) {
      try {
        const { data: modelRow } = await supabase.from("model_artifacts").select("coefficients").eq("market", m).eq("kind", "pwin_logistic").maybeSingle();
        pwinModelByMarket.set(m, (modelRow as any)?.coefficients ?? null);
      } catch { pwinModelByMarket.set(m, null); }
      const g = await loadChampionGenome(supabase, m as "us" | "india");
      genomeByMarket.set(m, g);
      const mandate = mandateByMarket.get(m) ?? await loadTradingMandate(supabase, m as "us" | "india");
      const resolvedHorizon = resolveHorizonDays(mandate, g.source === "champion" ? g.genome.horizon_days : null).days;
      horizonByMarket.set(m, resolvedHorizon);
      maeMfeByMarket.set(
        m,
        await getGlobalMaeMfePercentiles(
          supabase,
          m as "us" | "india",
          resolvedHorizon,
          g.genome.exit.stop_mae_pctile / 100,
          g.genome.exit.target_mfe_pctile / 100,
        ),
      );
    }

    // Owner-safe revert: return a claimed signal to `pending` and clear the claim
    // stamps, but ONLY if THIS run still owns it (status=claiming AND claim_run_id
    // = this run). Prevents one run from stealing back a row another run/chain has
    // since claimed — the dual scheduler (research chain + standalone cron) safety.
    const revertClaim = async (signalId: string) => {
      let q = supabase.from("agent_signals")
        .update({ status: "pending", claimed_at: null, claim_run_id: null })
        .eq("id", signalId).eq("status", "claiming");
      if (runId) q = q.eq("claim_run_id", runId);
      await q;
    };

    for (const signal of signals) {
      const market = hasMarketCol ? String(signal.market ?? (signal.asset_class === "india" ? "india" : "us")) : "us";
      const currency = market === "india" ? "INR" : "USD";
      const portfolio = poolByMarket.get(market);
      if (!portfolio) { skipped.push({ symbol: signal.symbol, reason: `no_pool_for_${market}` }); continue; }

      const openNames = openAlphaNamesByMarket.get(market) ?? new Set<string>();
      const marketNameCap = mandateByMarket.get(market)?.max_open_positions ?? 10;
      // Capital-rotation reachability: at the name cap the candidate is NOT
      // rejected here. It flows through the remaining gates (sector cap,
      // re-entry cooldown, pricing, sizing) and is evaluated as a rotation
      // candidate at the funding step below.
      //
      // This used to `continue`, which made the rotation path at the funding
      // step unreachable whenever the name cap bound first — the common case,
      // since the book exhausts its 10 slots long before it runs out of cash.
      // rotation_events stayed empty for 9 days with shadow enabled as a
      // result. Rotation is slot-for-slot (sell one, buy one), so bypassing the
      // cap here does not grow the book; if no rotation executes the candidate
      // is still skipped below with the same max_open_names reason.
      const atNameCap = !canOpenPaperName(openNames, signal.symbol, marketNameCap);
      if (atNameCap) {
        await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "portfolio_constructor", outcome: "deferred", reason: "max_open_names_rotation_candidate", detail: { current: openNames.size, cap: marketNameCap } });
      }

      // Idempotent claim — stamp ownership so only THIS run can revert it later.
      const { data: claimed } = await supabase
        .from("agent_signals")
        .update({ status: "claiming", claimed_at: new Date().toISOString(), claim_run_id: runId })
        .eq("id", signal.id).eq("status", "pending").select("id");
      if (!claimed || claimed.length === 0) continue;

      // Sector cap
      const candSector = await resolveSector(signal.symbol, signal.research_packet_id ?? null);
      const sectorCount = sectorCountByMarket.get(market) ?? {};
      if (candSector && (sectorCount[candSector] ?? 0) >= maxPerSector) {
        await revertClaim(signal.id);
        skipped.push({ symbol: signal.symbol, reason: `sector_cap (${candSector} already at ${maxPerSector})` });
        continue;
      }

      // Re-entry cooldown: block same-symbol BUY within 3 trading days of a close.
      // 5 calendar days covers weekends. SELL/exit signals bypass this check entirely.
      {
        const cooldownCutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
        let cooldownQ = supabase.from("paper_trades")
          .select("id", { count: "exact", head: true })
          .eq("symbol", signal.symbol)
          .eq("order_side", "buy")
          .not("closed_at", "is", null)
          .gte("closed_at", cooldownCutoff);
        if (hasMarketCol) cooldownQ = cooldownQ.eq("market", market);
        const { count: recentClose } = await cooldownQ;
        if ((recentClose ?? 0) > 0) {
          await revertClaim(signal.id);
          skipped.push({ symbol: signal.symbol, reason: "reentry_cooldown (closed within 3 trading days)" });
          await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "reentry_gate", outcome: "rejected", reason: "reentry_cooldown", detail: { cooldownCutoff } });
          continue;
        }
      }

      const pf = await priceFor(signal, market);
      if (!pf.ok) {
        await revertClaim(signal.id);
        skipped.push({ symbol: signal.symbol, reason: pf.reason });
        continue;
      }
      const { price, fillPrice, source, retrievedAt, bid, ask, spread } = pf;
      const tradingMandate = mandateByMarket.get(market) ?? await loadTradingMandate(supabase, market as "us" | "india");
      const resolvedHorizonDays = horizonByMarket.get(market) ?? tradingMandate.target_hold_days;
      const snapshot = mandateSnapshot(tradingMandate, resolvedHorizonDays);

      // Dynamic R:R (Phase 2): resolve a bounded market-local policy from the
      // eligible-long ledger when valid; otherwise use the current mandate.
      // Absolute levels are always anchored to the actual fill.
      const maeMfe = maeMfeByMarket.get(market);
      const riskReward = resolveExecutionRiskReward({
        mandateStopLossPct: tradingMandate.stop_loss_pct,
        mandateTargetPct: tradingMandate.target_pct,
        learned: maeMfe,
      });
      if (riskReward.source === "mandate") {
        // Invalid/insufficient learned data falls back to the mandate. Record it so
        // the briefing/Research Journal can tell the user whether sizing used
        // learned risk or static defaults for this fill.
        await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "portfolio_constructor", outcome: "passed", reason: "dynamic_rr_unavailable — using mandate stop/target", detail: { stopLossPct: tradingMandate.stop_loss_pct, targetPct: tradingMandate.target_pct } });
      }
      const boundPlan = bindTradePrices(fillPrice, riskReward);
      if (!boundPlan) {
        await revertClaim(signal.id);
        skipped.push({ symbol: signal.symbol, reason: "invalid_fill_trade_plan" });
        continue;
      }
      const { priceTarget, stopLoss } = boundPlan;
      await logStage(supabase, {
        signal_id: signal.id, symbol: signal.symbol, market,
        stage: "risk_plan", outcome: "passed",
        reason: `${riskReward.source} bound to fill`,
        detail: {
          research_stop_loss_pct: signal.stop_loss_pct ?? null,
          research_target_pct: signal.take_profit_pct ?? null,
          execution_stop_loss_pct: riskReward.stopLossPct,
          execution_target_pct: riskReward.targetPct,
          sample_size: riskReward.sampleSize,
          fill_price: fillPrice,
          stop_loss: stopLoss,
          price_target: priceTarget,
        },
      });

      // Conviction-scaled sizing (Phase 2): when a calibrated P(win) model
      // exists for this market, size via half-Kelly using this signal's own
      // dimension scores + the ledger's MFE/|MAE| median as the payoff ratio.
      // Falls back to the flat positionSizePct otherwise (unchanged default).
      // Build 1: the champion genome selects the sizing mode. "half_kelly"
      // (DEFAULT_GENOME) keeps the conviction path below; "flat" pins to the
      // configured positionSizePct. The genome's cap is clamped to the owner's
      // strategy_config position_size_pct — the learning loop can size DOWN but
      // NEVER above the owner-set per-position limit (money limits stay human).
      const genomeR = genomeByMarket.get(market);
      const sizing = genomeR?.genome.sizing ?? { mode: "half_kelly" as const, cap_pct: positionSizePct, floor_pct: Math.min(2, positionSizePct) };
      const kellyCapPct = Math.min(sizing.cap_pct, positionSizePct);
      const kellyFloorPct = Math.min(sizing.floor_pct, kellyCapPct);
      const pwinModel = pwinModelByMarket.get(market);
      let proposedSizePct = positionSizePct;
      if (sizing.mode === "half_kelly" && pwinModel && maeMfe) {
        const pWin = predictPWin(pwinModel, {
          fundamental_score: signal.fundamental_score, technical_score: signal.technical_score,
          sentiment_score: signal.sentiment_score, macro_score: signal.macro_score, insider_score: signal.insider_score,
        } as any);
        // Use the actual fill-bound priceTarget/stopLoss distances, not the raw
        // learned values, so sizing and the position's persisted exit plan share
        // one payoff ratio after bounds and fallbacks are applied.
        const targetPctActual = (priceTarget - fillPrice) / fillPrice;
        const stopPctActual = (fillPrice - stopLoss) / fillPrice;
        const payoffRatio = Math.abs(targetPctActual) / Math.max(0.001, Math.abs(stopPctActual));
        // kellyPositionSizePct works in FRACTIONS (0.10 = 10%) and returns a
        // fraction; positionSizePct here is a PERCENT (e.g. 10). Convert the
        // caps to fractions and scale the result back to percent. (Previously
        // percent-scale caps were passed into the fraction API, so the clamp
        // floor pinned every position to exactly the floor value regardless of
        // edge — conviction scaling was silently dead.) A no-edge result is 0,
        // which the finite/≤0 guard below correctly turns into a skip rather
        // than opening a floor-sized position.
        const kellyFrac = kellyPositionSizePct(pWin, payoffRatio, {
          halfKellyCap: kellyCapPct / 100,
          floorPct: kellyFloorPct / 100,
        });
        proposedSizePct = kellyFrac * 100;
      }

      // Portfolio Constructor: shrink the (possibly Kelly-scaled) proposed size
      // against this market's book (name/sector/gross/vol/correlation limits)
      // before spending cash. Never increases size.
      const dailyVol = await estimateDailyVolPct(signal.symbol, market as "us" | "india", supabase);
      // Allocation-aware gross cap: tighten (never raise) this market's gross-equity
      // limit toward the equity-sleeve target when allocation is enabled.
      const allocEquityCap = allocEquityCapByMarket.get(market);
      const marketLimits = allocEquityCap != null
        ? { ...portfolioLimits, maxGrossExposurePct: Math.min(portfolioLimits.maxGrossExposurePct, allocEquityCap) }
        : portfolioLimits;
      const constructed = constructPortfolio(
        bookByMarket.get(market) ?? [],
        [{ symbol: signal.symbol, market: market as "us" | "india", proposedSizePct, sector: candSector, beta: null, dailyVol }],
        marketLimits
      );
      const rawSizedPct = constructed.orders[0]?.finalSizePct ?? 0;
      // Finite-number gate — NaN fails every `<= 0` / `< 1` comparison below
      // (NaN <= 0 is false), so a NaN from an upstream model coefficient,
      // percentile, or config value would otherwise sail through every guard
      // and reach the RPC fill call with a NaN qty/totalCost.
      if (!Number.isFinite(rawSizedPct) || rawSizedPct <= 0) {
        await revertClaim(signal.id);
        const reason = Number.isFinite(rawSizedPct)
          ? `portfolio_constructor_denied: ${constructed.orders[0]?.adjustments.join("; ") ?? "no room"}`
          : "portfolio_constructor_denied: non-finite sizedPct";
        skipped.push({ symbol: signal.symbol, reason });
        await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "portfolio_constructor", outcome: "rejected", reason, detail: { proposedSizePct, adjustments: constructed.orders[0]?.adjustments } });
        continue;
      }
      const sizedPct = rawSizedPct;
      await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "portfolio_constructor", outcome: sizedPct < proposedSizePct ? "shrunk" : "passed", reason: `Sized ${sizedPct.toFixed(1)}% (proposed ${proposedSizePct.toFixed(1)}%)`, detail: { proposedSizePct, sizedPct, adjustments: constructed.orders[0]?.adjustments } });

      // Size off THIS pool's cash, in its own currency — bounded by the per-trade
      // paper notional cap (scaled to paper NAV) so an outlier can't exceed it.
      const perTradeCapPaper = market === "india" ? perTradeCapInrPaper : perTradeCapUsdPaper;
      const maxSpend = Math.min(portfolio.cash_balance * (sizedPct / 100), perTradeCapPaper != null ? Number(perTradeCapPaper) : Infinity);
      const qty = Math.floor(maxSpend / fillPrice);
      if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(maxSpend) || !Number.isFinite(qty) || qty < 1) {
        await revertClaim(signal.id);
        skipped.push({ symbol: signal.symbol, reason: "insufficient_cash_for_1_share" });
        await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "execution", outcome: "rejected", reason: "insufficient_cash_for_1_share", detail: { maxSpend, fillPrice } });
        continue;
      }
      const totalCost = qty * fillPrice;
      // Rotation is evaluated when the book cannot take this candidate as-is:
      // either it is out of cash (original trigger) or it is out of name slots
      // (added — this is the trigger that actually binds in practice).
      const cashShort = !Number.isFinite(totalCost) || totalCost > portfolio.cash_balance;
      if (atNameCap || cashShort) {
        const rotCandidate = {
          signalId: signal.id,
          symbol: signal.symbol,
          market: market as "us" | "india",
          currency: currency as "USD" | "INR",
          score: Number(signal.analyst_score ?? 0),
          targetNotional: totalCost,
          cash: Number(portfolio.cash_balance ?? 0),
        };
        // Always log the shadow evaluation (measurement).
        try {
          await recordCapitalRotationShadow(supabase, {
            runId,
            candidate: { ...rotCandidate, sector: candSector, dailyVol },
            scoreThreshold: tradingMandate.score_threshold,
            minHoldingDays: tradingMandate.min_hold_days ?? 2,
            resolvedHorizonDays,
            maxSignalAgeSessions: tradingMandate.max_signal_age_sessions,
            exitHysteresis: Number((cfg as any)?.exit_hysteresis) || 15,
            portfolioNav: constructorNavByMarket.get(market) ?? 0,
            book: bookByMarket.get(market) ?? [],
            portfolioLimits: marketLimits,
            existingPositionsPolicy: tradingMandate.existing_positions_policy,
          });
        } catch (e: any) {
          await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "capital_rotation", outcome: "rejected", reason: "rotation_shadow_log_failed", detail: { error: e?.message ?? String(e) } });
        }
        // Capital-rotation P1 PAPER execution is live (owner-approved 2026-07-23).
        // executeCapitalRotationPaper re-runs eligibility + persistence/cooldown/
        // daily-cap gates, then the execute_paper_rotation RPC atomically sells
        // the source and buys the candidate (buy-leg denial rolls back the sell).
        let rotReason = "not_attempted";
        try {
          const rot = await executeCapitalRotationPaper(supabase, {
            runId, rotationsThisRun: rotationsThisRun.get(market) ?? 0,
            candidate: { ...rotCandidate, qty, fillPrice, priceTarget, stopLoss, sector: candSector },
            scoreThreshold: tradingMandate.score_threshold, minHoldingDays: tradingMandate.min_hold_days ?? 2,
          });
          if (rot.executed) {
            rotationsThisRun.set(market, (rotationsThisRun.get(market) ?? 0) + 1);
            filled.push({ symbol: signal.symbol, qty, price: fillPrice, via: "capital_rotation", sold: rot.sourceSymbol });
            await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "execution", outcome: "filled", reason: `capital_rotation: sold ${rot.sourceSymbol} to fund ${signal.symbol}`, detail: { soldSymbol: rot.sourceSymbol, qty, fillPrice } });
            continue;
          }
          rotReason = rot.reason ?? "unknown";
        } catch (e: any) {
          rotReason = `rotation_execute_error:${e?.message ?? String(e)}`;
        }
        await revertClaim(signal.id);
        const blockReason = atNameCap ? `max_open_names (${marketNameCap})` : "insufficient_cash";
        skipped.push({ symbol: signal.symbol, reason: blockReason });
        await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "execution", outcome: "rejected", reason: blockReason, detail: { totalCost, cash: portfolio.cash_balance, atNameCap, cashShort, rotReason } });
        continue;
      }

      // Daily paper notional cap (per market): stop once the day's cumulative paper
      // BUY notional would exceed the cap. BUY only — never blocks a sell/exit.
      const dailyCapPaper = market === "india" ? dailyCapInrPaper : dailyCapUsdPaper;
      if (dailyCapPaper != null) {
        // Market-local trading-day window (not UTC midnight) — matches the
        // freshness cutoff so the cap counts the same day's fills.
        const dayStartIso = cutoffByMarket.get(market) ?? new Date(new Date().setUTCHours(0, 0, 0, 0)).toISOString();
        const { data: todayFills } = await supabase.from("paper_trades")
          .select("total_value").eq("market", market).eq("order_side", "buy")
          .gte("executed_at", dayStartIso);
        const spentToday = (todayFills ?? []).reduce((s: number, r: any) => s + Number(r.total_value ?? 0), 0);
        if (spentToday + totalCost > Number(dailyCapPaper)) {
          await revertClaim(signal.id);
          skipped.push({ symbol: signal.symbol, reason: "daily_paper_notional_cap" });
          await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "execution", outcome: "rejected", reason: "daily_paper_notional_cap", detail: { spentToday, totalCost, cap: Number(dailyCapPaper) } });
          continue;
        }
      }

      // Transactional fill: try the execute_paper_fill RPC first (one DB
      // transaction, row-locked — see migration 071 / Decision 34). Falls back
      // to the original multi-step JS sequence if the RPC is absent (pre-071).
      let orderEventId: any = null;
      let rpcSucceeded = false;
      {
        const { data: rpcData, error: rpcErr } = await supabase.rpc("execute_paper_fill", {
          p_signal_id: signal.id, p_market: market, p_currency: currency, p_symbol: signal.symbol,
          p_qty: qty, p_fill_price: fillPrice, p_total_cost: totalCost, p_price_source: source,
          p_price_retrieved_at: retrievedAt, p_bid: bid, p_ask: ask, p_spread: spread,
          p_analyst_score: signal.analyst_score, p_strategy_id: signal.source ?? "research",
          p_notes: signal.rationale?.slice(0, 500) ?? null,
          p_rationale: `${signal.rationale ?? ""} [source: ${source}, at: ${retrievedAt}]`,
          p_price_target: priceTarget, p_stop_loss: stopLoss, p_sector: candSector,
          // Build 4a: pre-slippage decision price. fill_price already carries the
          // slipped value; the RPC computes realized_slip_pct = fill/expected - 1.
          p_expected_price: price,
          p_mandate_id: (signal as any).mandate_id ?? null,
          p_mandate_version: tradingMandate.version,
          p_mandate_snapshot: snapshot,
          p_resolved_horizon_days: resolvedHorizonDays,
          p_max_open_names: tradingMandate.max_open_positions,
          p_max_sector_names: maxPerSector,
          p_per_trade_cap: perTradeCapPaper,
          p_daily_notional_cap: dailyCapPaper,
          p_day_start: cutoffByMarket.get(market) ?? null,
        } as any);
        const rpcMissing = rpcErr && (String((rpcErr as any).code ?? "") === "PGRST202" ||
          /could not find the function|does not exist/i.test(String(rpcErr.message ?? "")));
        if (rpcErr && !rpcMissing) {
          await revertClaim(signal.id);
          skipped.push({ symbol: signal.symbol, reason: `rpc_fill_failed: ${rpcErr.message}` });
          continue;
        }
        if (!rpcErr) {
          const result = rpcData as any;
          if (!result?.ok) {
            await revertClaim(signal.id);
            const denial = String(result?.error ?? "unknown");
            skipped.push({ symbol: signal.symbol, reason: `rpc_fill_denied: ${denial}` });
            await logStage(supabase, {
              signal_id: signal.id, symbol: signal.symbol, market,
              stage: denial === "pyramid_gate" ? "pyramid_gate" : "execution",
              outcome: "rejected", reason: `rpc_fill_denied:${denial}`, detail: result,
            });
            continue;
          }
          orderEventId = result.event_id;
          rpcSucceeded = true;
          if (candSector && !bookByMarket.get(market)?.some(b => b.symbol === signal.symbol)) {
            sectorCount[candSector] = (sectorCount[candSector] ?? 0) + 1;
            sectorCountByMarket.set(market, sectorCount);
          }
        }
      }

      if (!rpcSucceeded && process.env.VERCEL_ENV === "production") {
        // execute_paper_fill (migration 071) is expected to exist in production.
        // If it's ever missing there (dropped/renamed function, RPC grant
        // revoked), a multi-step non-transactional fallback risks leaving
        // partial event/trade/position/cash state on a crash — fail closed
        // instead. The fallback below remains available for local/dev/preview.
        await revertClaim(signal.id);
        skipped.push({ symbol: signal.symbol, reason: "execute_paper_fill_rpc_missing_in_production" });
        console.error("[paper-trade] execute_paper_fill RPC missing in production — refusing legacy fallback fill for", signal.symbol);
        continue;
      }

      if (!rpcSucceeded) {
        // ── Legacy fallback path (pre-071 migration, local/dev only) ──
        const eventRow: Record<string, any> = {
          event_type: "fill", symbol: signal.symbol, side: "buy", qty,
          fill_price: fillPrice, total_value: totalCost, price_source: source,
          price_retrieved_at: retrievedAt, bid_at_fill: bid, ask_at_fill: ask,
          spread_applied: spread, signal_id: signal.id, analyst_score: signal.analyst_score,
          strategy_id: signal.source ?? "research", notes: signal.rationale?.slice(0, 500) ?? null,
          market,
          // Build 4a: expected (pre-slip) price + realized slip. Optional keys below
          // so a pre-125 dev DB missing these columns still inserts.
          expected_price: price,
          realized_slip_pct: price > 0 ? fillPrice / price - 1 : null,
          fill_status: "filled",
        };
        const evRes = await insertOptional("paper_order_events", eventRow, ["market", "expected_price", "realized_slip_pct", "fill_status"], "id");
        if (evRes.error) {
          await revertClaim(signal.id);
          skipped.push({ symbol: signal.symbol, reason: `order_event_failed: ${evRes.error.message}` });
          continue;
        }
        const orderEvent = evRes.data;
        orderEventId = (orderEvent as any)?.id ?? null;

        const tradeRow: Record<string, any> = {
          symbol: signal.symbol, order_side: "buy", qty, fill_price: fillPrice,
          signal_id: signal.id, analyst_score: signal.analyst_score, direction: "long",
          rationale: `${signal.rationale ?? ""} [source: ${source}, at: ${retrievedAt}]`,
          fundamental_score: null, technical_score: null, sentiment_score: null, macro_score: null,
          price_source: source, price_retrieved_at: retrievedAt, spread_applied: spread,
          paper_event_id: orderEventId, market, currency,
          expected_price: price,
          realized_slip_pct: price > 0 ? fillPrice / price - 1 : null,
          fill_status: "filled",
          mandate_id: (signal as any).mandate_id ?? null,
          mandate_version: tradingMandate.version,
          mandate_snapshot: snapshot,
          resolved_horizon_days: resolvedHorizonDays,
        };
        const trRes = await insertOptional("paper_trades", tradeRow, ["currency", "market", "expected_price", "realized_slip_pct", "fill_status", "mandate_id", "mandate_version", "mandate_snapshot", "resolved_horizon_days"]);
        if (trRes.error) {
          await revertClaim(signal.id);
          skipped.push({ symbol: signal.symbol, reason: `trade_insert_failed: ${trRes.error.message}` });
          continue;
        }

        let existingQ = supabase.from("paper_positions").select("*").eq("symbol", signal.symbol);
        if (hasMarketCol) existingQ = existingQ.eq("market", market);
        const { data: existing } = await existingQ.maybeSingle();

        if (existing) {
          // Pyramid gate: only add to a position that is already in profit.
          // Never average down into a loser — that compounds drawdown.
          if (fillPrice <= Number(existing.avg_cost ?? 0)) {
            await revertClaim(signal.id);
            skipped.push({ symbol: signal.symbol, reason: "pyramid_gate (position is at a loss — no averaging down)" });
            await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "pyramid_gate", outcome: "rejected", reason: "pyramid_gate", detail: { fillPrice, avgCost: existing.avg_cost } });
            continue;
          }
          const newQty = existing.qty + qty;
          const newAvg = ((existing.qty * existing.avg_cost) + totalCost) / newQty;
          await supabase.from("paper_positions").update({ qty: newQty, avg_cost: newAvg, current_price: fillPrice }).eq("id", existing.id);
        } else {
          const newPosRow: Record<string, any> = {
            symbol: signal.symbol, qty, avg_cost: fillPrice, current_price: fillPrice,
            price_target: priceTarget, stop_loss: stopLoss, highest_price: fillPrice,
            sector: candSector, market, currency,
            mandate_version: tradingMandate.version,
            mandate_snapshot: snapshot,
            resolved_horizon_days: resolvedHorizonDays,
          };
          await insertOptional("paper_positions", newPosRow, ["sector", "currency", "market", "mandate_version", "mandate_snapshot", "resolved_horizon_days"]);
          if (candSector) sectorCount[candSector] = (sectorCount[candSector] ?? 0) + 1;
          sectorCountByMarket.set(market, sectorCount);
        }

        portfolio.cash_balance -= totalCost;
        await supabase.from("paper_portfolio").update({
          cash_balance: portfolio.cash_balance,
          total_invested: (portfolio.total_invested ?? 0) + totalCost,
        }).eq("id", portfolio.id);

        await supabase.from("agent_signals").update({ status: "paper_traded" }).eq("id", signal.id);
      } else {
        // RPC already committed cash/position/signal atomically — keep the
        // in-memory `portfolio.cash_balance` mirror in sync for later iterations.
        portfolio.cash_balance -= totalCost;
      }

      // Reflect this fill in the in-memory book so later signals THIS RUN see it
      // (matches the existing sectorCount accumulation pattern above).
      const nav = constructorNavByMarket.get(market) ?? portfolio.cash_balance;
      const bookEntry: BookPosition = {
        symbol: signal.symbol, sector: candSector,
        valuePct: nav > 0 ? (totalCost / nav) * 100 : 0,
        beta: null, dailyVol,
      };
      const currentBook = bookByMarket.get(market) ?? [];
      const existingBookIdx = currentBook.findIndex(b => b.symbol === signal.symbol);
      if (existingBookIdx >= 0) currentBook[existingBookIdx].valuePct += bookEntry.valuePct;
      else currentBook.push(bookEntry);
      bookByMarket.set(market, currentBook);
      openNames.add(String(signal.symbol).toUpperCase());
      openAlphaNamesByMarket.set(market, openNames);

      await logStage(supabase, { signal_id: signal.id, symbol: signal.symbol, market, stage: "execution", outcome: "filled", reason: `${qty} @ ${fillPrice.toFixed(2)}`, detail: { qty, fillPrice, totalCost, sizedPct } });

      const sym = market === "india" ? "₹" : "$";
      const { error: journalErr } = await supabase.from("decision_journal").insert({
        entry_type: "paper_fill", symbol: signal.symbol, signal_id: signal.id, market,
        paper_event_id: orderEventId,
        summary: `Paper buy (${market.toUpperCase()}): ${qty} × ${signal.symbol} @ ${sym}${fillPrice.toFixed(2)} (score ${signal.analyst_score}, source: ${source})`,
        calculations: { market, currency, qty, fill_price: fillPrice, total_cost: totalCost, spread_applied: spread, analyst_score: signal.analyst_score, trading_mandate: snapshot, sizing: { flat_pct: positionSizePct, kelly_proposed_pct: proposedSizePct, final_pct: sizedPct, used_calibrated_model: !!pwinModel, mode: sizing.mode, cap_pct: kellyCapPct, floor_pct: kellyFloorPct, adjustments: constructed.orders[0]?.adjustments ?? [] }, genome: { source: genomeR?.source ?? "default", hash: genomeR?.hash ?? null, horizon_days: genomeR?.genome.horizon_days ?? 10, score_threshold: genomeR?.genome.entry.score_threshold ?? 60 } },
        evidence_refs: [{ table: "agent_signals", id: signal.id, description: "qualifying signal" }],
        has_verified_facts: true, has_calculations: true, resolved: false,
      });
      if (journalErr) console.error("[paper-trade] decision_journal insert failed:", journalErr.message);

      filled.push({ symbol: signal.symbol, market, qty, fillPrice, totalCost, currency, priceSource: source });
    }

    // ── Per-market NAV snapshot ───────────────────────────────────────────────
    const { data: allPositions } = await supabase.from("paper_positions").select("*");
    const positions: any[] = allPositions ?? [];

    // Refresh US prices in one batch; India per-symbol via Yahoo.
    const usSyms = [...new Set(positions.filter(p => (hasMarketCol ? (p.market ?? "us") : "us") === "us").map(p => p.symbol as string))];
    if (usSyms.length) {
      const quotes = await getBatchQuotes(usSyms, supabase);
      for (const pos of positions) {
        if ((hasMarketCol ? (pos.market ?? "us") : "us") !== "us") continue;
        const q = quotes[pos.symbol];
        if (q?.price > 0) { await supabase.from("paper_positions").update({ current_price: q.price }).eq("id", pos.id); pos.current_price = q.price; }
      }
    }
    if (hasMarketCol) {
      for (const pos of positions.filter(p => (p.market ?? "us") === "india")) {
        const q = await fetchIndiaQuote(pos.symbol);
        if (q && q.price > 0) { await supabase.from("paper_positions").update({ current_price: q.price }).eq("id", pos.id); pos.current_price = q.price; }
      }
    }

    const today = new Date().toISOString().split("T")[0];
    const navByMarket: Record<string, number> = {};

    for (const market of activeMarkets) {
      const pool = poolByMarket.get(market);
      if (!pool) continue;
      const mktPositions = positions.filter(p => (hasMarketCol ? (p.market ?? "us") : "us") === market);
      const positionsValue = mktPositions.reduce((s, p) => s + p.qty * (p.current_price ?? p.avg_cost), 0);
      const nav = pool.cash_balance + positionsValue;
      navByMarket[market] = nav;

      const [previousPerfResult, resolvedTradesResult] = await Promise.all([
        supabase.from("paper_performance").select("nav").eq("market", market)
          .lt("date", today).order("date", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("paper_trades").select("outcome").eq("market", market)
          .not("outcome", "is", null),
      ]);
      if (previousPerfResult.error) throw new Error(`Previous NAV read failed (${market}): ${previousPerfResult.error.message}`);
      if (resolvedTradesResult.error) throw new Error(`Paper outcomes read failed (${market}): ${resolvedTradesResult.error.message}`);
      const previousPerf = previousPerfResult.data;
      const resolvedTrades = resolvedTradesResult.data;
      const outcomes = (resolvedTrades ?? []) as Array<{ outcome: string | null }>;

      // Per-market benchmark for alpha + the return-vs-benchmark chart:
      // US = VOO, India = NIFTY 50 (^NSEI). Stored provider-neutral in bench_*.
      // Cumulative bench return is measured vs the FIRST recorded bench_nav for
      // this market. Fail-soft: if the benchmark quote is unavailable this run,
      // leave bench_*/alpha null rather than corrupting the series.
      let benchNav: number | null = null, benchReturnPct: number | null = null;
      try {
        const benchSym = market === "india" ? "^NSEI" : "VOO";
        const q = market === "india" ? await fetchIndiaQuote(benchSym) : await getQuote(benchSym, supabase);
        const px = (q as any)?.price;
        benchNav = typeof px === "number" && px > 0 ? px : null;
        if (benchNav) {
          const { data: firstPerf } = await supabase.from("paper_performance")
            .select("bench_nav").eq("market", market).not("bench_nav", "is", null)
            .order("date", { ascending: true }).limit(1).maybeSingle();
          const benchStartNav = (firstPerf as any)?.bench_nav ?? benchNav;
          benchReturnPct = benchStartNav ? ((benchNav - benchStartNav) / benchStartNav) * 100 : null;
        }
      } catch { /* benchmark unavailable this run — leave null */ }

      const truth = paperPerformanceTruth({
        market: market as "us" | "india",
        nav,
        previousNav: previousPerf?.nav == null ? null : Number(previousPerf.nav),
        benchReturnPct,
        winCount: outcomes.filter((t) => t.outcome === "win").length,
        lossCount: outcomes.filter((t) => t.outcome === "loss").length,
        resolvedTradeCount: outcomes.length,
      });

      const perfRow: Record<string, any> = {
        date: today, nav, cash_balance: pool.cash_balance, positions_value: positionsValue,
        ...truth,
        bench_nav: benchNav, bench_return_pct: benchReturnPct, market,
        // Back-compat: US readers still keyed on spy_* (VOO tracks the S&P 500 too).
        spy_nav: market === "us" ? benchNav : null,
        spy_return_pct: market === "us" ? benchReturnPct : null,
      };
      const { error: perfErr } = await supabase.from("paper_performance").upsert(perfRow, { onConflict: "date,market" });
      if (perfErr) { // pre-057: no market column / composite key
        delete perfRow.market;
        const { error: fallbackErr } = await supabase.from("paper_performance").upsert(perfRow, { onConflict: "date" });
        if (fallbackErr) throw new Error(`paper_performance write failed (${market}): ${fallbackErr.message}`);
      }
      const { error: navErr } = await supabase.from("paper_portfolio").update({ nav }).eq("id", pool.id);
      if (navErr) throw new Error(`paper_portfolio NAV write failed (${market}): ${navErr.message}`);
    }

    if (runId) {
      const tradedSymbols = filled.map((f: any) => f.symbol);
      const navSummary = Object.entries(navByMarket).map(([m, n]) => `${m}:${m === "india" ? "₹" : "$"}${n.toFixed(2)}`).join(" ");
      const skipReasons = skipped.reduce<Record<string, number>>((counts, item) => {
        const reason = String(item?.reason ?? "unknown");
        counts[reason] = (counts[reason] ?? 0) + 1;
        return counts;
      }, {});
      const skipSummary = Object.entries(skipReasons)
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => `${reason}=${count}`)
        .join(", ");
      await supabase.from("agent_runs").update({
        status: "done", symbols: tradedSymbols, signals_written: filled.length,
        result_summary: `${filled.length} trades filled, ${skipped.length} skipped${skipSummary ? ` (${skipSummary})` : ""}, ${expiredTotal} stale expired. NAV ${navSummary}`,
        workload_metrics: { skip_reasons: skipReasons },
        completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
      } as any).eq("id", runId);
    }

    return NextResponse.json({ success: true, filled: filled.length, skipped: skipped.length, expired: expiredTotal, trades: filled, nav: navByMarket });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Finalize the run as errored so a throw can't leave it stuck 'running'
    // (the zombie-run failure mode). Fail-soft: never mask the original error.
    if (runId) {
      try {
        await supabase.from("agent_runs").update({
          status: "error", result_summary: msg.slice(0, 500), completed_at: new Date().toISOString(),
        } as any).eq("id", runId);
      } catch { /* best-effort */ }
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
