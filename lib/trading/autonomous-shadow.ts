import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAutonomousExecution,
  computeAutonomousSizing,
  type LiveAutoPolicy,
  type KernelResult,
  type SizingResult,
} from "@/lib/trading/execution-kernel";
import { getQuote } from "@/lib/data/quotes";
import { getKiteMargins, getKiteHoldings } from "@/lib/kite";
import { fetchIndiaQuote } from "@/lib/india-data";

const SIGNAL_LOOKBACK_HOURS = 24;
// Robinhood agentic account — read-only NAV for US shadow.
const US_NAV_ACCOUNT_ID = "605420660";

export interface ShadowRunResult {
  run_id: string;
  market: string;
  evaluated: number;
  would_go: number;
  rejected: number;
  budget_dry_run: {
    daily_cap: number | null;
    currency: string;
    spent_today: number;
    remaining: number | null;
  };
  results: Array<{
    symbol: string;
    market: string;
    signal_id: string;
    proposal_id: number | null;
    kernel: KernelResult;
    sizing: SizingResult | null;
  }>;
}

export async function runAutonomousShadow(
  svc: SupabaseClient,
  runId: string,
  market: "us" | "india" = "us",
): Promise<ShadowRunResult> {
  const runStart = new Date().toISOString();
  const currency = market === "india" ? "INR" : "USD";

  // 1. Snapshot policy + India INR caps from strategy_config.
  const { data: config, error: cfgErr } = await svc
    .from("strategy_config")
    .select(
      "live_auto_enabled,live_auto_enabled_until,live_auto_policy_version," +
      "live_auto_daily_cap_usd,live_auto_max_per_order_usd," +
      "live_auto_min_evidence_confidence,live_auto_max_open_positions," +
      "live_auto_max_orders_per_day,score_threshold,position_size_pct," +
      "max_order_notional_inr,max_daily_notional_inr"
    )
    .limit(1)
    .single();

  if (cfgErr || !config) throw new Error("Could not read strategy_config");

  const cfg = config as any;
  const policy: LiveAutoPolicy = {
    live_auto_enabled:                 cfg.live_auto_enabled ?? false,
    live_auto_enabled_until:           cfg.live_auto_enabled_until ?? null,
    live_auto_policy_version:          cfg.live_auto_policy_version ?? 1,
    live_auto_daily_cap_usd:           cfg.live_auto_daily_cap_usd ?? null,
    live_auto_max_per_order_usd:       cfg.live_auto_max_per_order_usd ?? null,
    live_auto_max_per_order_inr:       cfg.max_order_notional_inr ?? null,
    live_auto_min_evidence_confidence: cfg.live_auto_min_evidence_confidence ?? null,
    live_auto_max_open_positions:      cfg.live_auto_max_open_positions ?? null,
    live_auto_max_orders_per_day:      cfg.live_auto_max_orders_per_day ?? null,
  };
  const scoreThreshold: number = cfg.score_threshold ?? 60;
  const flatSizePct: number    = cfg.position_size_pct ?? 10;

  // 2. Market-local day start for budget/order-count windows. The DB helper is
  // DST-safe for US and uses Asia/Kolkata for India; do not substitute UTC.
  const { data: marketDayStart, error: dayErr } = await svc.rpc("market_trading_day_start", { p_market: market });
  if (dayErr || !marketDayStart) throw new Error(`Could not resolve ${market} trading-day start`);
  const todayStartIso = String(marketDayStart);

  // 3. NAV — currency-correct, no cross-currency fallback.
  //    US: Robinhood USD snapshot. India: live Kite INR margins + holdings.
  let liveNav        = 0;
  let navCapturedAt  = new Date(0).toISOString();

  if (market === "us") {
    const { data: navSnap } = await svc
      .from("live_account_snapshots")
      .select("equity, captured_at")
      .eq("account_id", US_NAV_ACCOUNT_ID)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    liveNav       = Number((navSnap as any)?.equity) || 0;
    navCapturedAt = (navSnap as any)?.captured_at ?? new Date(0).toISOString();
  } else {
    // India: live Kite INR equity net + holdings market value.
    // Fails closed — a missing/stale NAV keeps liveNav=0 → noSize("no_live_nav").
    try {
      const [margins, holdings] = await Promise.all([
        getKiteMargins(svc),
        getKiteHoldings(svc),
      ]);
      let inrNav = 0;
      if (margins.ok && typeof margins.equityNet === "number") inrNav += margins.equityNet;
      const hlist: any[] = (holdings as any)?.data ?? (holdings as any)?.holdings ?? [];
      for (const h of Array.isArray(hlist) ? hlist : []) {
        const qty = Number(h.quantity ?? h.qty ?? 0);
        const px  = Number(h.last_price ?? h.ltp ?? 0);
        if (Number.isFinite(qty) && Number.isFinite(px)) inrNav += qty * px;
      }
      if (margins.ok && inrNav > 0) {
        liveNav       = inrNav;
        navCapturedAt = new Date().toISOString();
      }
    } catch { /* leave liveNav=0 → fail closed */ }
  }

  // 4. Kelly calibration from last 100 closed paper_trades for this market.
  const { data: closedTrades } = await svc
    .from("paper_trades")
    .select("pnl_pct")
    .eq("market", market)
    .not("closed_at", "is", null)
    .not("pnl_pct", "is", null)
    .order("closed_at", { ascending: false })
    .limit(100);

  let winRate: number | null     = null;
  let payoffRatio: number | null = null;
  const pnls = (closedTrades ?? []).map((t: any) => parseFloat(t.pnl_pct));
  if (pnls.length >= 10) {
    const wins   = pnls.filter((p: number) => p > 0);
    const losses = pnls.filter((p: number) => p <= 0);
    if (wins.length > 0 && losses.length > 0) {
      const avgWin  = wins.reduce((a, b) => a + b, 0) / wins.length / 100;
      const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) / 100;
      winRate     = wins.length / pnls.length;
      payoffRatio = avgWin / Math.max(0.001, avgLoss);
    }
  }

  // 5. Budget dry-run: today's market-local live spend against the market cap.
  const dailyCap = market === "india"
    ? (cfg.max_daily_notional_inr ?? null)
    : policy.live_auto_daily_cap_usd;

  const { data: liveOrders } = await svc
    .from("broker_orders")
    .select("estimated_value")
    .eq("market", market)
    .in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile"])
    .gte("created_at", todayStartIso);
  const spentToday = (liveOrders ?? []).reduce(
    (s: number, r: any) => s + Number(r.estimated_value ?? 0), 0,
  );
  const budgetDryRun = {
    daily_cap:  dailyCap,
    currency,
    spent_today: spentToday,
    remaining:  dailyCap != null ? dailyCap - spentToday : null,
  };

  // 6. Count shadow proposals already created today + open positions — market-scoped.
  const { count: ordersToday } = await svc
    .from("trade_proposals")
    .select("id", { count: "exact", head: true })
    .eq("execution_mode", "autonomous_shadow")
    .eq("market", market)
    .gte("created_at", todayStartIso);

  const { data: fills } = await svc
    .from("broker_orders")
    .select("symbol, side, qty")
    .eq("market", market)
    .eq("status", "filled");
  const netQty: Record<string, number> = {};
  for (const o of (fills ?? []) as any[]) {
    const q = Number(o.qty) || 0;
    netQty[o.symbol] = (netQty[o.symbol] ?? 0) + (o.side === "sell" ? -q : q);
  }
  const openPositions = Object.values(netQty).filter((v) => v > 1e-9).length;

  // 7. Query qualifying signals for this market.
  const lookbackCutoff = new Date(
    Date.now() - SIGNAL_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();

  const { data: signals, error: signalErr } = await svc
    .from("agent_signals")
    .select("id, symbol, market, direction, analyst_score, conviction, score_source, rationale")
    .eq("score_source", "deterministic_v1")
    .eq("direction", "long")
    .eq("market", market)
    .gte("analyst_score", scoreThreshold)
    .gte("created_at", lookbackCutoff)
    .order("analyst_score", { ascending: false })
    .limit(policy.live_auto_max_orders_per_day ?? 10);
  if (signalErr) throw new Error(`shadow signal query failed: ${signalErr.message}`);

  const results: ShadowRunResult["results"] = [];
  let shadowOrdersThisRun = 0;

  for (const signal of signals ?? []) {
    const { data: observation, error: observationErr } = await svc.from("decision_observations")
      .select("id,setup_type,evidence_confidence").eq("signal_id", signal.id)
      .order("ts", { ascending: false }).limit(1).maybeSingle();
    if (observationErr) throw new Error(`shadow observation lookup failed for ${signal.symbol}: ${observationErr.message}`);
    const evidenceConfidence = Number((observation as any)?.evidence_confidence);
    const { data: proposal, error: propErr } = await svc
      .from("trade_proposals")
      .insert({
        symbol:          signal.symbol,
        market,
        side:            "buy",
        order_type:      "market",
        signal_id:       signal.id,
        analyst_score:   signal.analyst_score,
        thesis:          signal.rationale ?? null,
        status:          "pending_review",
        execution_mode:  "autonomous_shadow",
        auto_run_id:     runId,
        auto_decided_at: new Date().toISOString(),
        policy_snapshot: { policy, score_threshold: scoreThreshold, run_id: runId, run_start: runStart },
      })
      .select("id")
      .single();

    if (propErr || !proposal) {
      results.push({
        symbol:      signal.symbol,
        market,
        signal_id:   signal.id,
        proposal_id: null,
        sizing:      null,
        kernel: {
          go: false,
          shadow_status: "manual_review_required",
          gate_failed: "proposal_insert_failed",
          reason: propErr?.message ?? "insert returned no row",
          policy_version: policy.live_auto_policy_version,
          evaluated_at: new Date().toISOString(),
        },
      });
      continue;
    }

    const kernel = evaluateAutonomousExecution({
      symbol:                signal.symbol,
      market,
      direction:             signal.direction ?? "long",
      score:                 signal.analyst_score ?? 0,
      evidence_confidence:   Number.isFinite(evidenceConfidence) ? evidenceConfidence : 0,
      score_threshold:       scoreThreshold,
      proposed_notional_usd: 0,
      policy,
      current_open_positions: openPositions,
      orders_placed_today:    (ordersToday ?? 0) + shadowOrdersThisRun,
      evaluation_mode:        "shadow",
    });

    let sizing: SizingResult | null = null;
    const proposalUpdate: Record<string, any> = {
      status: kernel.shadow_status,
    };

    if (kernel.go) {
      let currentPrice = 0;
      let priceStale   = true;
      try {
        if (market === "india") {
          const quote = await fetchIndiaQuote(signal.symbol);
          currentPrice = quote?.price ?? 0;
          priceStale = !quote || currentPrice <= 0;
        } else {
          const quote = await getQuote(signal.symbol, svc);
          currentPrice = quote.price ?? 0;
          priceStale = quote.stale || quote.source === "unavailable" || currentPrice <= 0;
        }
      } catch { /* sizing will reflect no_current_price */ }

      sizing = computeAutonomousSizing({
        nav:              liveNav,
        nav_captured_at:  navCapturedAt,
        current_price:    currentPrice,
        price_stale:      priceStale,
        win_rate:         winRate,
        payoff_ratio:     payoffRatio,
        flat_size_pct:    flatSizePct,
        policy,
        market,
      });

      if (sizing.ok) {
        proposalUpdate.qty               = sizing.proposed_qty;
        proposalUpdate.estimated_value   = sizing.estimated_notional;
        proposalUpdate.pct_of_nav        = sizing.pct_of_nav;
        proposalUpdate.price_at_proposal = currentPrice;
        proposalUpdate.price_source      = "autonomous_shadow";
        shadowOrdersThisRun++;
      } else {
        proposalUpdate.status = "manual_review_required";
      }
    }

    proposalUpdate.policy_snapshot = {
      policy, score_threshold: scoreThreshold,
      run_id: runId, run_start: runStart,
      kernel, sizing,
    };

    await svc.from("trade_proposals").update(proposalUpdate).eq("id", proposal.id);

    // Persist shadow evidence for this market's champion.
    const { data: champion } = await svc.from("strategy_versions")
      .select("id").eq("market", market).eq("is_champion", true)
      .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (observation?.id) {
      let existingQuery = svc.from("shadow_decisions").select("id").eq("observation_id", observation.id);
      existingQuery = champion?.id
        ? existingQuery.eq("policy_version_id", champion.id)
        : existingQuery.is("policy_version_id", null);
      const { data: existing } = await existingQuery.maybeSingle();
      if (!existing) {
        await svc.from("shadow_decisions").insert({
          market,
          symbol:           signal.symbol,
          observation_id:   observation.id,
          policy_version_id: champion?.id ?? null,
          would_enter:      kernel.go && Boolean(sizing?.ok),
          score:            signal.analyst_score,
          size_pct:         sizing?.ok ? sizing.pct_of_nav : null,
          entry_price:      sizing?.ok ? (proposalUpdate.price_at_proposal ?? null) : null,
          setup_type:       observation.setup_type ?? null,
        });
      }
    }

    results.push({
      symbol:      signal.symbol,
      market,
      signal_id:   signal.id,
      proposal_id: proposal.id,
      kernel,
      sizing,
    });
  }

  const went    = results.filter((r) => r.kernel.go && r.sizing?.ok).length;
  const blocked = results.length - went;

  await svc.from("decision_journal").insert({
    entry_type: "autonomous_shadow_run",
    market,
    summary:
      `Shadow run ${runId} [${market}]: ${results.length} signal(s) — ` +
      `${went} sized+queued, ${blocked} rejected/unsized. ` +
      `Budget: ${currency} ${spentToday.toFixed(0)} spent / ` +
      `${dailyCap != null ? currency + " " + dailyCap : "uncapped"} daily cap.`,
  } as any);

  return {
    run_id:         runId,
    market,
    evaluated:      results.length,
    would_go:       went,
    rejected:       blocked,
    budget_dry_run: budgetDryRun,
    results,
  };
}
