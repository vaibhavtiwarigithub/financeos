import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getQuote, getBatchQuotes, computeFillPrice } from "@/lib/data/quotes";
import { fetchIndiaQuote } from "@/lib/india-data";
import { checkKillSwitches } from "@/lib/kill-switches";
import { constructPortfolio, DEFAULT_LIMITS, type BookPosition } from "@/lib/portfolio/constructor";
import { estimateDailyVolPct } from "@/lib/portfolio/inputs";

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

const START_NAV: Record<string, number> = { us: 10000, india: 1000000 };

export async function POST(req: NextRequest) {
  try {
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    // Optional ?market=us|india — scope a run to one pool (India cron fills only
    // the ₹ pool, US cron only the $ pool). No param = all active markets.
    const mktParam = new URL(req.url).searchParams.get("market");
    const marketScope = mktParam === "india" ? "india" : mktParam === "us" ? "us" : null;

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const supabase = createServiceClient();

    const { data: cfg } = await supabase
      .from("strategy_config")
      .select("app_paused, score_threshold, position_size_pct, stop_loss_pct, target_pct")
      .limit(1)
      .single();
    if ((cfg as any)?.app_paused) {
      return NextResponse.json({ skipped: true, reason: "App is paused — paper trades disabled" });
    }
    let maxPerSector = 3;
    try {
      const { data: capRow } = await supabase.from("strategy_config").select("max_positions_per_sector").limit(1).single();
      if ((capRow as any)?.max_positions_per_sector != null) maxPerSector = Number((capRow as any).max_positions_per_sector);
    } catch { /* column not present yet — keep default 3 */ }

    const scoreThreshold  = (cfg as any)?.score_threshold   ?? 60;
    const positionSizePct = (cfg as any)?.position_size_pct ?? 10;
    const stopLossPctCfg  = (cfg as any)?.stop_loss_pct     ?? 7;
    const targetPctCfg    = (cfg as any)?.target_pct        ?? 20;

    const { data: runRow } = await supabase.from("agent_runs").insert({
      agent_type: "paper_trader", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

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
      return NextResponse.json({ error: "No paper portfolio found" }, { status: 500 });
    }
    let activeMarkets = [...poolByMarket.keys()]; // 'us' always; 'india' when 057 applied
    if (marketScope) activeMarkets = activeMarkets.filter(m => m === marketScope); // scoped cron run

    // Kill-switches are evaluated PER MARKET (each on its own currency's NAV/
    // drawdown/accuracy). A tripped market is skipped; the others still fill.
    const ksByMarket: Record<string, { safe: boolean; reason?: string; tripped?: string }> = {};
    for (const m of activeMarkets) ksByMarket[m] = await checkKillSwitches(supabase, m);
    activeMarkets = activeMarkets.filter(m => ksByMarket[m].safe);
    if (activeMarkets.length === 0) {
      const first = Object.values(ksByMarket)[0];
      return NextResponse.json({ skipped: true, reason: first?.reason ?? "All markets kill-switched", tripped: first?.tripped });
    }

    // ── Qualifying signals across active markets ─────────────────────────────
    // India signals only get pulled when the India pool exists (hasMarketCol +
    // seeded), so pre-057 this is byte-for-byte the old US-only behavior.
    let signals: any[] | null = null;
    if (hasMarketCol) {
      const { data } = await supabase
        .from("agent_signals").select("*")
        .eq("status", "pending").eq("direction", "long")
        .in("market", activeMarkets)
        .gte("analyst_score", scoreThreshold)
        .order("analyst_score", { ascending: false }).limit(10);
      signals = data;
    } else {
      const { data } = await supabase
        .from("agent_signals").select("*")
        .eq("status", "pending").eq("direction", "long")
        .neq("asset_class", "india")
        .gte("analyst_score", scoreThreshold)
        .order("analyst_score", { ascending: false }).limit(5);
      signals = data;
    }

    if (!signals || signals.length === 0) {
      if (runId) await supabase.from("agent_runs").update({ status: "done", signals_written: 0, result_summary: `No qualifying long signals (score ≥ ${scoreThreshold}, direction = long)`, completed_at: new Date().toISOString() } as any).eq("id", runId);
      return NextResponse.json({ skipped: true, reason: `No qualifying long signals (score ≥ ${scoreThreshold}, direction = long)` });
    }

    const filled: any[] = [];
    const skipped: any[] = [];

    // Sector cap — count open positions per sector (across all markets; the cap
    // is a book-level concentration limit).
    const { data: openPos } = await supabase.from("paper_positions").select("symbol, sector, qty, avg_cost, market");
    const sectorCount: Record<string, number> = {};
    for (const p of (openPos ?? []) as any[]) {
      if (p.sector) sectorCount[p.sector] = (sectorCount[p.sector] ?? 0) + 1;
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

    for (const signal of signals) {
      const market = hasMarketCol ? String(signal.market ?? (signal.asset_class === "india" ? "india" : "us")) : "us";
      const currency = market === "india" ? "INR" : "USD";
      const portfolio = poolByMarket.get(market);
      if (!portfolio) { skipped.push({ symbol: signal.symbol, reason: `no_pool_for_${market}` }); continue; }

      // Idempotent claim
      const { data: claimed } = await supabase
        .from("agent_signals").update({ status: "claiming" })
        .eq("id", signal.id).eq("status", "pending").select("id");
      if (!claimed || claimed.length === 0) continue;

      // Sector cap
      const candSector = await resolveSector(signal.symbol, signal.research_packet_id ?? null);
      if (candSector && (sectorCount[candSector] ?? 0) >= maxPerSector) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: `sector_cap (${candSector} already at ${maxPerSector})` });
        continue;
      }

      const pf = await priceFor(signal, market);
      if (!pf.ok) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: pf.reason });
        continue;
      }
      const { price, fillPrice, source, retrievedAt, bid, ask, spread } = pf;

      const priceTarget = signal.price_target != null ? signal.price_target
        : parseFloat((fillPrice * (1 + targetPctCfg / 100)).toFixed(2));
      const stopLoss = signal.stop_loss != null ? signal.stop_loss
        : parseFloat((fillPrice * (1 - stopLossPctCfg / 100)).toFixed(2));

      // Portfolio Constructor: shrink the flat size against this market's book
      // (name/sector/gross/vol/correlation limits) before spending cash. Never
      // increases size; degrades to the flat positionSizePct when unconstrained.
      const dailyVol = await estimateDailyVolPct(signal.symbol, market as "us" | "india", supabase);
      const constructed = constructPortfolio(
        bookByMarket.get(market) ?? [],
        [{ symbol: signal.symbol, market: market as "us" | "india", proposedSizePct: positionSizePct, sector: candSector, beta: null, dailyVol }],
        portfolioLimits
      );
      const sizedPct = constructed.orders[0]?.finalSizePct ?? 0;
      if (sizedPct <= 0) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: `portfolio_constructor_denied: ${constructed.orders[0]?.adjustments.join("; ") ?? "no room"}` });
        continue;
      }

      // Size off THIS pool's cash, in its own currency
      const maxSpend = portfolio.cash_balance * (sizedPct / 100);
      const qty = Math.floor(maxSpend / fillPrice);
      if (qty < 1) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "insufficient_cash_for_1_share" });
        continue;
      }
      const totalCost = qty * fillPrice;
      if (totalCost > portfolio.cash_balance) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "insufficient_cash" });
        continue;
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
        } as any);
        const rpcMissing = rpcErr && (String((rpcErr as any).code ?? "") === "PGRST202" ||
          /could not find the function|does not exist/i.test(String(rpcErr.message ?? "")));
        if (rpcErr && !rpcMissing) {
          await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
          skipped.push({ symbol: signal.symbol, reason: `rpc_fill_failed: ${rpcErr.message}` });
          continue;
        }
        if (!rpcErr) {
          const result = rpcData as any;
          if (!result?.ok) {
            await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
            skipped.push({ symbol: signal.symbol, reason: `rpc_fill_denied: ${result?.error ?? "unknown"}` });
            continue;
          }
          orderEventId = result.event_id;
          rpcSucceeded = true;
          if (candSector && !bookByMarket.get(market)?.some(b => b.symbol === signal.symbol)) {
            sectorCount[candSector] = (sectorCount[candSector] ?? 0) + 1;
          }
        }
      }

      if (!rpcSucceeded) {
        // ── Legacy fallback path (pre-071 migration) — unchanged behavior ──
        const eventRow: Record<string, any> = {
          event_type: "fill", symbol: signal.symbol, side: "buy", qty,
          fill_price: fillPrice, total_value: totalCost, price_source: source,
          price_retrieved_at: retrievedAt, bid_at_fill: bid, ask_at_fill: ask,
          spread_applied: spread, signal_id: signal.id, analyst_score: signal.analyst_score,
          strategy_id: signal.source ?? "research", notes: signal.rationale?.slice(0, 500) ?? null,
          market,
        };
        const evRes = await insertOptional("paper_order_events", eventRow, ["market"], "id");
        if (evRes.error) {
          await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
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
        };
        const trRes = await insertOptional("paper_trades", tradeRow, ["currency", "market"]);
        if (trRes.error) {
          await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
          skipped.push({ symbol: signal.symbol, reason: `trade_insert_failed: ${trRes.error.message}` });
          continue;
        }

        let existingQ = supabase.from("paper_positions").select("*").eq("symbol", signal.symbol);
        if (hasMarketCol) existingQ = existingQ.eq("market", market);
        const { data: existing } = await existingQ.maybeSingle();

        if (existing) {
          const newQty = existing.qty + qty;
          const newAvg = ((existing.qty * existing.avg_cost) + totalCost) / newQty;
          await supabase.from("paper_positions").update({ qty: newQty, avg_cost: newAvg, current_price: fillPrice }).eq("id", existing.id);
        } else {
          const newPosRow: Record<string, any> = {
            symbol: signal.symbol, qty, avg_cost: fillPrice, current_price: fillPrice,
            price_target: priceTarget, stop_loss: stopLoss, highest_price: fillPrice,
            sector: candSector, market, currency,
          };
          await insertOptional("paper_positions", newPosRow, ["sector", "currency", "market"]);
          if (candSector) sectorCount[candSector] = (sectorCount[candSector] ?? 0) + 1;
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

      const sym = market === "india" ? "₹" : "$";
      const { error: journalErr } = await supabase.from("decision_journal").insert({
        entry_type: "paper_fill", symbol: signal.symbol, signal_id: signal.id,
        paper_event_id: orderEventId,
        summary: `Paper buy (${market.toUpperCase()}): ${qty} × ${signal.symbol} @ ${sym}${fillPrice.toFixed(2)} (score ${signal.analyst_score}, source: ${source})`,
        calculations: { market, currency, qty, fill_price: fillPrice, total_cost: totalCost, spread_applied: spread, analyst_score: signal.analyst_score, sizing: { proposed_pct: positionSizePct, final_pct: sizedPct, adjustments: constructed.orders[0]?.adjustments ?? [] } },
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
      const startNav = START_NAV[market] ?? pool.nav ?? nav;
      const returnPct = startNav ? ((nav - startNav) / startNav) * 100 : 0;

      // US keeps the SPY alpha benchmark; India has no USD benchmark.
      let spyNav: number | null = null, spyReturnPct: number | null = null, alphaPct: number | null = null;
      if (market === "us") {
        const spyQuote = await getQuote("SPY", supabase);
        spyNav = spyQuote.price > 0 ? spyQuote.price : null;
        const { data: firstPerf } = await supabase.from("paper_performance").select("spy_nav").not("spy_nav", "is", null).order("date", { ascending: true }).limit(1).single();
        const spyStartNav = (firstPerf as any)?.spy_nav ?? spyNav;
        spyReturnPct = (spyNav && spyStartNav) ? ((spyNav - spyStartNav) / spyStartNav) * 100 : null;
        alphaPct = spyReturnPct != null ? returnPct - spyReturnPct : null;
      }

      const perfRow: Record<string, any> = {
        date: today, nav, cash_balance: pool.cash_balance, positions_value: positionsValue,
        total_pnl: nav - startNav, total_pnl_pct: returnPct,
        spy_nav: spyNav, spy_return_pct: spyReturnPct, alpha_pct: alphaPct, market,
      };
      const { error: perfErr } = await supabase.from("paper_performance").upsert(perfRow, { onConflict: "date,market" });
      if (perfErr) { // pre-057: no market column / composite key
        delete perfRow.market;
        await supabase.from("paper_performance").upsert(perfRow, { onConflict: "date" });
      }
      await supabase.from("paper_portfolio").update({ nav }).eq("id", pool.id);
    }

    if (runId) {
      const tradedSymbols = filled.map((f: any) => f.symbol);
      const navSummary = Object.entries(navByMarket).map(([m, n]) => `${m}:${m === "india" ? "₹" : "$"}${n.toFixed(2)}`).join(" ");
      await supabase.from("agent_runs").update({
        status: "done", symbols: tradedSymbols, signals_written: filled.length,
        result_summary: `${filled.length} trades filled, ${skipped.length} skipped. NAV ${navSummary}`,
        completed_at: new Date().toISOString(), tokens_input: 0, tokens_output: 0, claude_calls: 0,
      } as any).eq("id", runId);
    }

    return NextResponse.json({ success: true, filled: filled.length, skipped: skipped.length, trades: filled, nav: navByMarket });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
