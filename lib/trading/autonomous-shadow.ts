import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAutonomousExecution,
  computeAutonomousSizing,
  type LiveAutoPolicy,
  type KernelResult,
  type SizingResult,
} from "@/lib/trading/execution-kernel";
import { getQuote } from "@/lib/data/quotes";

const SIGNAL_LOOKBACK_HOURS = 24;
// Trading account for live NAV reads — read-only, never order placement.
const NAV_ACCOUNT_ID = "605420660";

export interface ShadowRunResult {
  run_id: string;
  evaluated: number;
  would_go: number;
  rejected: number;
  budget_dry_run: {
    daily_cap_usd: number | null;
    spent_today_usd: number;
    remaining_usd: number | null;
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
): Promise<ShadowRunResult> {
  const runStart = new Date().toISOString();

  // 1. Snapshot policy from strategy_config.
  const { data: config, error: cfgErr } = await svc
    .from("strategy_config")
    .select(
      "live_auto_enabled,live_auto_enabled_until,live_auto_policy_version," +
      "live_auto_daily_cap_usd,live_auto_max_per_order_usd,live_auto_min_evidence_confidence," +
      "live_auto_max_open_positions,live_auto_max_orders_per_day,score_threshold,position_size_pct"
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
    live_auto_min_evidence_confidence: cfg.live_auto_min_evidence_confidence ?? null,
    live_auto_max_open_positions:      cfg.live_auto_max_open_positions ?? null,
    live_auto_max_orders_per_day:      cfg.live_auto_max_orders_per_day ?? null,
  };
  const scoreThreshold: number = cfg.score_threshold ?? 60;
  const flatSizePct: number = cfg.position_size_pct ?? 10;

  // 2. UTC calendar day start.
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // 3. Fetch NAV from live_account_snapshots (read-only; no MCP needed).
  //    Fails closed — no fallback NAV.
  const { data: navSnap } = await svc
    .from("live_account_snapshots")
    .select("equity, captured_at")
    .eq("account_id", NAV_ACCOUNT_ID)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const liveNav: number = Number((navSnap as any)?.equity) || 0;
  const navCapturedAt: string = (navSnap as any)?.captured_at ?? new Date(0).toISOString();

  // 4. Fetch paper_trades for Kelly calibration (last 100 closed).
  const { data: closedTrades } = await svc
    .from("paper_trades")
    .select("pnl_pct")
    .not("closed_at", "is", null)
    .not("pnl_pct", "is", null)
    .order("closed_at", { ascending: false })
    .limit(100);

  let winRate: number | null = null;
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

  // 5. Budget dry-run: read today's live spend (not the atomic reservation — informational only).
  const { data: liveOrders } = await svc
    .from("broker_orders")
    .select("estimated_value")
    .in("status", ["pending_submit", "submitted", "partially_filled", "unknown_needs_reconcile"])
    .gte("created_at", todayStart.toISOString());
  const spentToday = (liveOrders ?? []).reduce(
    (s: number, r: any) => s + Number(r.estimated_value ?? 0), 0,
  );
  const dailyCap = policy.live_auto_daily_cap_usd;
  const budgetDryRun = {
    daily_cap_usd: dailyCap,
    spent_today_usd: spentToday,
    remaining_usd: dailyCap != null ? dailyCap - spentToday : null,
  };

  // 6. Count shadow proposals already created today + open positions.
  const { count: ordersToday } = await svc
    .from("trade_proposals")
    .select("id", { count: "exact", head: true })
    .eq("execution_mode", "autonomous_shadow")
    .gte("created_at", todayStart.toISOString());

  const { count: openPositions } = await svc
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .eq("status", "filled");

  // 7. Query qualifying signals.
  const lookbackCutoff = new Date(
    Date.now() - SIGNAL_LOOKBACK_HOURS * 3_600_000,
  ).toISOString();

  const { data: signals } = await svc
    .from("agent_signals")
    .select("id, symbol, market, direction, analyst_score, evidence_confidence, score_source, rationale")
    .eq("score_source", "deterministic_v1")
    .eq("direction", "long")
    .eq("market", "us")
    .gte("analyst_score", scoreThreshold)
    .gte("created_at", lookbackCutoff)
    .order("analyst_score", { ascending: false })
    .limit(policy.live_auto_max_orders_per_day ?? 10);

  const results: ShadowRunResult["results"] = [];
  let shadowOrdersThisRun = 0;

  for (const signal of signals ?? []) {
    // Create proposal row (temp status=pending_review; updated after kernel).
    const { data: proposal, error: propErr } = await svc
      .from("trade_proposals")
      .insert({
        symbol:          signal.symbol,
        market:          signal.market ?? "us",
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
        market:      signal.market ?? "us",
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

    // Run execution kernel (all 9 gates).
    const kernel = evaluateAutonomousExecution({
      symbol:               signal.symbol,
      market:               signal.market ?? "us",
      direction:            signal.direction ?? "long",
      score:                signal.analyst_score ?? 0,
      evidence_confidence:  signal.evidence_confidence ?? 0,
      score_threshold:      scoreThreshold,
      proposed_notional_usd: 0, // notional gate uses sizing result below
      policy,
      current_open_positions: openPositions ?? 0,
      orders_placed_today:    (ordersToday ?? 0) + shadowOrdersThisRun,
      evaluation_mode:        "shadow",
    });

    let sizing: SizingResult | null = null;
    const proposalUpdate: Record<string, any> = {
      status: kernel.shadow_status,
    };

    if (kernel.go) {
      // PA2: compute sizing for proposals that pass all gates.
      let currentPrice = 0;
      let priceStale = true;
      try {
        const quote = await getQuote(signal.symbol, svc);
        currentPrice = quote.price ?? 0;
        priceStale   = quote.stale || quote.source === "unavailable" || currentPrice <= 0;
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
      });

      if (sizing.ok) {
        proposalUpdate.qty               = sizing.proposed_qty;
        proposalUpdate.estimated_value   = sizing.estimated_notional;
        proposalUpdate.pct_of_nav        = sizing.pct_of_nav;
        proposalUpdate.price_at_proposal = currentPrice;
        proposalUpdate.price_source      = "autonomous_shadow";
        shadowOrdersThisRun++;
      } else {
        // Sizing failed — downgrade to manual_review_required.
        proposalUpdate.status = "manual_review_required";
      }
    }

    proposalUpdate.policy_snapshot = {
      policy,
      score_threshold: scoreThreshold,
      run_id: runId,
      run_start: runStart,
      kernel,
      sizing,
    };

    await svc.from("trade_proposals").update(proposalUpdate).eq("id", proposal.id);

    const { data: observation } = await svc.from("decision_observations")
      .select("id,setup_type").eq("signal_id", signal.id)
      .order("ts", { ascending: false }).limit(1).maybeSingle();
    const { data: champion } = await svc.from("strategy_versions")
      .select("id").eq("market", "us").eq("is_champion", true)
      .order("promoted_at", { ascending: false }).limit(1).maybeSingle();
    if (observation?.id) {
      let existingQuery = svc.from("shadow_decisions").select("id").eq("observation_id", observation.id);
      existingQuery = champion?.id ? existingQuery.eq("policy_version_id", champion.id) : existingQuery.is("policy_version_id", null);
      const { data: existing } = await existingQuery.maybeSingle();
      if (!existing) {
        await svc.from("shadow_decisions").insert({
          market: "us", symbol: signal.symbol, observation_id: observation.id,
          policy_version_id: champion?.id ?? null,
          would_enter: kernel.go && Boolean(sizing?.ok), score: signal.analyst_score,
          size_pct: sizing?.ok ? sizing.pct_of_nav : null,
          entry_price: sizing?.ok ? proposalUpdate.price_at_proposal ?? null : null,
          setup_type: observation.setup_type ?? null,
        });
      }
    }

    results.push({
      symbol:      signal.symbol,
      market:      signal.market ?? "us",
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
    summary:
      `Shadow run ${runId}: ${results.length} signal(s) — ` +
      `${went} sized+queued_auto, ${blocked} rejected/unsized. ` +
      `Budget: $${spentToday.toFixed(0)} spent / ${dailyCap != null ? "$" + dailyCap : "uncapped"} daily cap.`,
  } as any);

  return {
    run_id:         runId,
    evaluated:      results.length,
    would_go:       went,
    rejected:       blocked,
    budget_dry_run: budgetDryRun,
    results,
  };
}
