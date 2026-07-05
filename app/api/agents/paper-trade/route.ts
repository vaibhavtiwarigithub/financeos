import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getQuote, getBatchQuotes, computeFillPrice } from "@/lib/data/quotes";
import { checkKillSwitches } from "@/lib/kill-switches";

// PaperTrader: fills virtual long-only trades from qualifying signals.
// Prices come from Robinhood MCP via fetchQuote — never from LLM estimation.
// Long-only enforcement: only processes direction="long" signals.
export async function POST(req: NextRequest) {
  try {
    // Allow cron/service calls via x-cron-secret header (no browser session available)
    const cronSecret = req.headers.get("x-cron-secret");
    const isCron = cronSecret && cronSecret === process.env.CRON_SECRET;

    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // All DB ops use service client — bypasses RLS on agent/paper tables
    const supabase = createServiceClient();

    // Pause check + risk profile params. max_positions_per_sector may not exist
    // until migration 056 is applied — select it separately so its absence
    // doesn't error the whole config read; fall back to the balanced default 3.
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

    // Risk profile parameters (fall back to balanced defaults)
    const scoreThreshold  = (cfg as any)?.score_threshold   ?? 60;
    const positionSizePct = (cfg as any)?.position_size_pct ?? 10;
    const stopLossPctCfg  = (cfg as any)?.stop_loss_pct     ?? 7;
    const targetPctCfg    = (cfg as any)?.target_pct        ?? 20;

    // §4 kill-switch check before any trade execution
    const ks = await checkKillSwitches(supabase);
    if (!ks.safe) {
      return NextResponse.json({ skipped: true, reason: ks.reason, tripped: ks.tripped });
    }

    const { data: runRow } = await supabase.from("agent_runs").insert({
      agent_type: "paper_trader", status: "running",
      trigger_source: isCron ? "scheduled" : "manual",
    } as any).select().single();
    const runId = (runRow as any)?.id ?? null;

    // Get paper portfolio
    const { data: portfolioArr } = await supabase.from("paper_portfolio").select("*").limit(1);
    let portfolio = portfolioArr?.[0];
    if (!portfolio) {
      const { data: newP } = await supabase
        .from("paper_portfolio")
        .insert({ cash_balance: 10000, nav: 10000 })
        .select()
        .single();
      portfolio = newP;
    }
    if (!portfolio) {
      return NextResponse.json({ error: "No paper portfolio found" }, { status: 500 });
    }

    // Only qualifying LONG signals not yet paper-traded (threshold from risk
    // profile). India (asset_class "india") is excluded — those are INR-priced
    // NSE stocks and the paper_portfolio is a single USD pool; mixing currencies
    // would corrupt NAV. India is scored + tracked (Score Tracker / signals) and
    // acted on via real Kite orders, not USD paper fills.
    const { data: signals } = await supabase
      .from("agent_signals")
      .select("*")
      .eq("status", "pending")
      .eq("direction", "long") // long-only enforcement
      .neq("asset_class", "india")
      .gte("analyst_score", scoreThreshold)
      .order("analyst_score", { ascending: false })
      .limit(5);

    if (!signals || signals.length === 0) {
      if (runId) await supabase.from("agent_runs").update({ status: "done", signals_written: 0, result_summary: `No qualifying long signals (score ≥ ${scoreThreshold}, direction = long)`, completed_at: new Date().toISOString() } as any).eq("id", runId);
      return NextResponse.json({ skipped: true, reason: `No qualifying long signals (score ≥ ${scoreThreshold}, direction = long)` });
    }

    const filled: any[] = [];
    const skipped: any[] = [];

    // Sector concentration guardrail. Count how many open positions are already
    // in each sector, then refuse to open more than max_positions_per_sector in
    // any one — so the book can't silently become 8/10 tech. This is a hard
    // human-set risk limit (from the risk profile), NOT something the agents
    // tune. Sector comes from the research packet's fundamentals; when it's
    // unknown (ETF/missing data) the cap can't be enforced for that name, so it
    // isn't counted against a sector.
    const { data: openPos } = await supabase.from("paper_positions").select("symbol, sector");
    const sectorCount: Record<string, number> = {};
    for (const p of (openPos ?? []) as any[]) {
      if (p.sector) sectorCount[p.sector] = (sectorCount[p.sector] ?? 0) + 1;
    }
    // Resolve a symbol's sector from its most recent research packet (raw_data
    // -> _scores -> evidence -> fundamental -> sector). Returns null if unknown.
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

    for (const signal of signals) {
      // Idempotent claim: atomically set status→'claiming' only if still 'pending'
      // Prevents duplicate fills if this route is called concurrently
      const { data: claimed } = await supabase
        .from("agent_signals")
        .update({ status: "claiming" })
        .eq("id", signal.id)
        .eq("status", "pending")
        .select("id");
      if (!claimed || claimed.length === 0) continue; // already claimed

      // Sector cap check — before spending a price fetch. If this candidate's
      // sector is already at the limit, release the claim and skip it (the next
      // best candidate from a different sector still gets its turn).
      const candSector = await resolveSector(signal.symbol, signal.research_packet_id ?? null);
      if (candSector && (sectorCount[candSector] ?? 0) >= maxPerSector) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: `sector_cap (${candSector} already at ${maxPerSector})` });
        continue;
      }

      // Fetch real price: AV GLOBAL_QUOTE → price_cache (no MCP cold-start)
      const quote = await getQuote(signal.symbol, supabase);

      if (quote.source === "unavailable" || quote.price <= 0) {
        await supabase.from("agent_signals").update({ status: "pending" }).eq("id", signal.id);
        skipped.push({ symbol: signal.symbol, reason: "price_unavailable" });
        continue;
      }

      // Fill price = ask + 0.05% slippage (Phase 0 deterministic price model)
      const fillPrice = computeFillPrice(quote);
      const spreadApplied = fillPrice / quote.price - 1; // effective spread ratio

      // Compute exit management levels at entry using risk profile params
      // Use price_target / stop_loss from signal if ResearchAgent already computed them
      const priceTarget = signal.price_target != null
        ? signal.price_target
        : parseFloat((fillPrice * (1 + targetPctCfg / 100)).toFixed(2));
      const stopLoss = signal.stop_loss != null
        ? signal.stop_loss
        : parseFloat((fillPrice * (1 - stopLossPctCfg / 100)).toFixed(2));

      // Size: positionSizePct% of current NAV (from risk profile), whole shares only
      const maxSpend = portfolio.cash_balance * (positionSizePct / 100);
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

      // Append-only audit event (paper_order_events is immutable after insert)
      const { data: orderEvent } = await supabase.from("paper_order_events").insert({
        event_type:         "fill",
        symbol:             signal.symbol,
        side:               "buy",
        qty,
        fill_price:         fillPrice,
        total_value:        totalCost,
        price_source:       quote.source,
        price_retrieved_at: quote.retrievedAt,
        bid_at_fill:        quote.bid,
        ask_at_fill:        quote.ask,
        spread_applied:     spreadApplied,
        signal_id:          signal.id,
        analyst_score:      signal.analyst_score,
        strategy_id:        signal.source ?? "research",
        notes:              signal.rationale?.slice(0, 500) ?? null,
      }).select("id").single();

      // Record paper trade with price provenance
      await supabase.from("paper_trades").insert({
        symbol:             signal.symbol,
        order_side:         "buy",
        qty,
        fill_price:         fillPrice,
        signal_id:          signal.id,
        analyst_score:      signal.analyst_score,
        direction:          "long",
        rationale:          `${signal.rationale ?? ""} [source: ${quote.source}, at: ${quote.retrievedAt}]`,
        fundamental_score:  null,
        technical_score:    null,
        sentiment_score:    null,
        macro_score:        null,
        price_source:       quote.source,
        price_retrieved_at: quote.retrievedAt,
        spread_applied:     spreadApplied,
        paper_event_id:     (orderEvent as any)?.id ?? null,
      });

      // Update or create paper position
      const { data: existing } = await supabase
        .from("paper_positions")
        .select("*")
        .eq("symbol", signal.symbol)
        .single();

      if (existing) {
        const newQty = existing.qty + qty;
        const newAvg = ((existing.qty * existing.avg_cost) + totalCost) / newQty;
        await supabase
          .from("paper_positions")
          .update({ qty: newQty, avg_cost: newAvg, current_price: fillPrice })
          .eq("id", existing.id);
      } else {
        const newPosRow: Record<string, any> = {
          symbol: signal.symbol,
          qty,
          avg_cost: fillPrice,
          current_price: fillPrice,
          price_target: priceTarget,
          stop_loss: stopLoss,
          highest_price: fillPrice,
          sector: candSector, // for the sector-concentration cap (migration 056)
        };
        const { error: posErr } = await supabase.from("paper_positions").insert(newPosRow);
        if (posErr) {
          // sector column not present yet (056 not applied) — insert without it.
          delete newPosRow.sector;
          await supabase.from("paper_positions").insert(newPosRow);
        }
        // Count this new position against its sector so later candidates in the
        // same run respect the cap too.
        if (candSector) sectorCount[candSector] = (sectorCount[candSector] ?? 0) + 1;
      }

      // Deduct from cash
      portfolio.cash_balance -= totalCost;
      await supabase
        .from("paper_portfolio")
        .update({
          cash_balance: portfolio.cash_balance,
          total_invested: (portfolio.total_invested ?? 0) + totalCost,
        })
        .eq("id", portfolio.id);

      // Mark signal as paper-traded
      await supabase.from("agent_signals").update({ status: "paper_traded" }).eq("id", signal.id);

      // Phase 4: decision journal entry for this fill — was fire-and-forget
      // with no error check, so a schema drift or transient failure here
      // would silently vanish. Await it and log failures.
      const { error: journalErr } = await supabase.from("decision_journal").insert({
        entry_type: "paper_fill",
        symbol: signal.symbol,
        signal_id: signal.id,
        paper_event_id: (orderEvent as any)?.id ?? null,
        summary: `Paper buy: ${qty} × ${signal.symbol} @ $${fillPrice.toFixed(2)} (score ${signal.analyst_score}, source: ${quote.source})`,
        calculations: { qty, fill_price: fillPrice, total_cost: totalCost, spread_applied: spreadApplied, analyst_score: signal.analyst_score },
        evidence_refs: [{ table: "agent_signals", id: signal.id, description: "qualifying signal" }],
        has_verified_facts: true,
        has_calculations: true,
        resolved: false,
      });
      if (journalErr) console.error("[paper-trade] decision_journal insert failed:", journalErr.message);

      filled.push({ symbol: signal.symbol, qty, fillPrice, totalCost, priceSource: quote.source });
    }

    // Refresh prices for all open positions before NAV snapshot
    const { data: positions } = await supabase.from("paper_positions").select("*");
    const openPositions: any[] = positions ?? [];

    if (openPositions.length > 0) {
      const symbols: string[] = [...new Set(openPositions.map((p: any) => p.symbol as string))];
      const quotes = await getBatchQuotes(symbols, supabase);
      for (const pos of openPositions) {
        const q = quotes[pos.symbol];
        if (q?.price > 0) {
          await supabase.from("paper_positions").update({ current_price: q.price }).eq("id", pos.id);
          pos.current_price = q.price;
        }
      }
    }

    const positionsValue = openPositions.reduce(
      (s: number, p: any) => s + p.qty * (p.current_price ?? p.avg_cost),
      0
    );
    const nav = portfolio.cash_balance + positionsValue;
    const today = new Date().toISOString().split("T")[0];

    // Phase 3: SPY benchmark for alpha tracking
    const spyQuote = await getQuote("SPY", supabase);
    const spyNav = spyQuote.price > 0 ? spyQuote.price : null;

    // First SPY price (from earliest paper_performance row) as benchmark start
    const { data: firstPerf } = await supabase
      .from("paper_performance")
      .select("spy_nav, date")
      .not("spy_nav", "is", null)
      .order("date", { ascending: true })
      .limit(1)
      .single();

    const spyStartNav = (firstPerf as any)?.spy_nav ?? spyNav;
    const spyReturnPct = (spyNav && spyStartNav)
      ? ((spyNav - spyStartNav) / spyStartNav) * 100
      : null;
    const paperReturnPct = ((nav - 10000) / 10000) * 100;
    const alphaPct = spyReturnPct != null ? paperReturnPct - spyReturnPct : null;

    await supabase.from("paper_performance").upsert(
      {
        date: today,
        nav,
        cash_balance: portfolio.cash_balance,
        positions_value: positionsValue,
        total_pnl: nav - 10000,
        total_pnl_pct: paperReturnPct,
        spy_nav: spyNav,
        spy_return_pct: spyReturnPct,
        alpha_pct: alphaPct,
      },
      { onConflict: "date" }
    );

    await supabase.from("paper_portfolio").update({ nav }).eq("id", portfolio.id);

    if (runId) {
      const tradedSymbols = filled.map((f: any) => f.symbol);
      await supabase.from("agent_runs").update({
        status: "done",
        symbols: tradedSymbols,
        signals_written: filled.length,
        result_summary: `${filled.length} trades filled, ${skipped.length} skipped. NAV: $${nav.toFixed(2)}`,
        completed_at: new Date().toISOString(),
        tokens_input: 0,
        tokens_output: 0,
        claude_calls: 0,
      } as any).eq("id", runId);
    }

    return NextResponse.json({ success: true, filled: filled.length, skipped: skipped.length, trades: filled, nav });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
