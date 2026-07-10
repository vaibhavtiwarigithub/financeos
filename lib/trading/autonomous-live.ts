import type { SupabaseClient } from "@supabase/supabase-js";
import {
  evaluateAutonomousExecution,
  computeAutonomousSizing,
  type LiveAutoPolicy,
  type KernelResult,
  type SizingResult,
} from "@/lib/trading/execution-kernel";
import { AUTONOMOUS_LIVE_ENABLED } from "@/lib/autonomy";
import { getQuote } from "@/lib/data/quotes";
import { rhPlaceMarketOrder } from "@/lib/brokers/robinhood/rest-client";
import { placeEquityOrder } from "@/lib/kite";
import { checkKillSwitches } from "@/lib/kill-switches";

const SIGNAL_LOOKBACK_HOURS = 24;
const NAV_ACCOUNT_ID = "605420660";

export interface LiveRunResult {
  run_id: string;
  early_exit?: string;
  evaluated: number;
  submitted: number;
  rejected: number;
  reconcile_needed: number;
  results: Array<{
    symbol: string;
    market: string;
    signal_id: number;
    proposal_id: number | null;
    broker_order_id: number | null;
    broker_order_ref: string | null;
    kernel: KernelResult | null;
    sizing: SizingResult | null;
    broker_status: "submitted" | "needs_reconcile" | "broker_error" | "budget_error" | "gate_blocked" | "sizing_failed";
    error?: string;
  }>;
}

function earlyExit(reason: string): LiveRunResult {
  return { run_id: "", early_exit: reason, evaluated: 0, submitted: 0, rejected: 0, reconcile_needed: 0, results: [] };
}

export async function runAutonomousLive(
  svc: SupabaseClient,
  runId: string,
): Promise<LiveRunResult> {
  const runStart = new Date().toISOString();

  // G1: deployment flag
  if (!AUTONOMOUS_LIVE_ENABLED) {
    return { ...earlyExit("deployment_flag_inactive"), run_id: runId };
  }

  // Read full policy
  const { data: config, error: cfgErr } = await svc
    .from("strategy_config")
    .select(
      "live_auto_enabled,live_auto_enabled_until,live_auto_policy_version," +
      "live_auto_daily_cap_usd,live_auto_max_per_order_usd,live_auto_min_evidence_confidence," +
      "live_auto_max_open_positions,live_auto_max_orders_per_day,score_threshold,position_size_pct," +
      "live_auto_mode_us,live_auto_mode_india," +
      "max_daily_notional_usd,max_daily_notional_inr,max_daily_trades," +
      "app_paused,security_locked,trading_enabled,trading_enabled_us,trading_enabled_india"
    )
    .limit(1)
    .single();

  if (cfgErr || !config) throw new Error("Could not read strategy_config");
  const cfg = config as any;

  // G2: global kill switches
  if (cfg.app_paused) return { ...earlyExit("app_paused"), run_id: runId };
  if (cfg.security_locked) return { ...earlyExit("security_locked"), run_id: runId };
  if (!cfg.trading_enabled) return { ...earlyExit("trading_disabled"), run_id: runId };

  // G3: DB master toggle
  if (!cfg.live_auto_enabled) return { ...earlyExit("db_toggle_off"), run_id: runId };

  // G4: lease — require a VALID FUTURE lease. A null/absent lease must NOT pass
  // on a live-money path (fail closed).
  if (!cfg.live_auto_enabled_until || new Date(cfg.live_auto_enabled_until) <= new Date()) {
    return { ...earlyExit("lease_missing_or_expired"), run_id: runId };
  }

  // Determine which markets are in autonomous mode. A market must be BOTH in
  // autonomous mode AND not view-only: the per-market trading_enabled_us/india
  // kill switch (honored by the manual gateways) also blocks the autonomous
  // path — flipping a market to view-only stops auto orders for it, even if its
  // mode column is still "autonomous".
  // Require the per-market view-only flag to be EXPLICITLY true (fail closed on
  // null/absent — never assume enabled on a live-money path).
  const autonomousMarkets: string[] = [];
  if (cfg.live_auto_mode_us === "autonomous" && cfg.trading_enabled_us === true) autonomousMarkets.push("us");
  if (cfg.live_auto_mode_india === "autonomous" && cfg.trading_enabled_india === true) autonomousMarkets.push("india");
  if (autonomousMarkets.length === 0) {
    return { ...earlyExit("no_markets_in_autonomous_mode"), run_id: runId };
  }

  // Fresh per-market kill-switch check (drawdown / daily-loss / accuracy) — the
  // REAL risk engine, not just the cached config booleans above. Drop any market
  // whose switch is tripped; fail closed if the check itself errors.
  const killedMarkets: Record<string, string> = {};
  for (const m of [...autonomousMarkets]) {
    let ks: { safe: boolean; reason?: string };
    try { ks = await checkKillSwitches(svc, m); }
    catch (e: any) { ks = { safe: false, reason: `kill-switch check failed: ${e?.message ?? "error"}` }; }
    if (!ks.safe) {
      killedMarkets[m] = ks.reason ?? "kill switch tripped";
      autonomousMarkets.splice(autonomousMarkets.indexOf(m), 1);
    }
  }
  if (autonomousMarkets.length === 0) {
    return { ...earlyExit(`kill_switch_tripped:${JSON.stringify(killedMarkets)}`), run_id: runId };
  }

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

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  // Fetch NAV — no fallback, fails closed
  const { data: navSnap } = await svc
    .from("live_account_snapshots")
    .select("equity, captured_at")
    .eq("account_id", NAV_ACCOUNT_ID)
    .order("captured_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const liveNav: number = Number((navSnap as any)?.equity) || 0;
  const navCapturedAt: string = (navSnap as any)?.captured_at ?? new Date(0).toISOString();

  // Kelly calibration from last 100 closed paper_trades
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
    const wins = pnls.filter((p: number) => p > 0);
    const losses = pnls.filter((p: number) => p <= 0);
    if (wins.length > 0 && losses.length > 0) {
      const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length / 100;
      const avgLoss = Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) / 100;
      winRate = wins.length / pnls.length;
      payoffRatio = avgWin / Math.max(0.001, avgLoss);
    }
  }

  // Open position count
  const { count: openPositions } = await svc
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .eq("status", "filled");

  // Count live orders placed today
  const { count: ordersToday } = await svc
    .from("broker_orders")
    .select("id", { count: "exact", head: true })
    .eq("broker_env", "live")
    .gte("created_at", todayStart.toISOString())
    .not("status", "in", "(error,rejected,canceled,cancelled)");

  // Query qualifying signals for autonomous markets only
  const lookbackCutoff = new Date(Date.now() - SIGNAL_LOOKBACK_HOURS * 3_600_000).toISOString();

  const { data: signals, error: sigErr } = await svc
    .from("agent_signals")
    // NOTE: the confidence column on agent_signals is `confidence` (aliased to
    // evidence_confidence for the kernel). A previous build selected a
    // nonexistent `evidence_confidence` column and SWALLOWED the resulting
    // PostgREST error, so this path silently processed zero signals every run.
    .select("id, symbol, market, direction, analyst_score, confidence, score_source, rationale")
    .eq("score_source", "deterministic_v1")
    .eq("direction", "long")
    .gte("analyst_score", scoreThreshold)
    .gte("created_at", lookbackCutoff)
    .in("market", autonomousMarkets)
    .order("analyst_score", { ascending: false })
    .limit(policy.live_auto_max_orders_per_day ?? 3);

  // Fail LOUDLY on a query error — never silently no-op the whole autonomous run.
  if (sigErr) {
    await svc.from("agent_runs").insert({
      agent_type: "autonomous_live", status: "error", trigger_source: "scheduled",
      completed_at: new Date().toISOString(),
      result_summary: `autonomous-live signal query failed: ${sigErr.message}`,
    } as any).then(() => {}, () => {});
    throw new Error(`autonomous-live signal query failed: ${sigErr.message}`);
  }

  const results: LiveRunResult["results"] = [];
  let liveOrdersThisRun = 0;

  for (const signal of signals ?? []) {
    const market = signal.market ?? "us";
    const broker = market === "india" ? "kite" : "robinhood";
    const currency = market === "india" ? "INR" : "USD";
    // Effective daily notional ceiling for the auto path. US: the owner's
    // live_auto_daily_cap_usd (the "don't spend more than $X/day" guardrail on
    // the Live-Auto settings page) binds first, falling back to the generic
    // max_daily_notional_usd. India: its own INR ceiling (live_auto_daily_cap_usd
    // is USD-denominated and there is no FX on this path, so it does not apply to
    // an INR order — the India INR cap must be set explicitly). NULL = no ceiling,
    // which we treat as fail-closed below (autonomy must be bounded).
    const effectiveDailyNotional = market === "india"
      ? cfg.max_daily_notional_inr ?? null
      : (policy.live_auto_daily_cap_usd ?? cfg.max_daily_notional_usd ?? null);

    // Insert proposal as autonomous_live
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
        execution_mode:  "autonomous_live",
        auto_run_id:     runId,
        auto_decided_at: new Date().toISOString(),
        policy_snapshot: { policy, score_threshold: scoreThreshold, run_id: runId, run_start: runStart },
      })
      .select("id")
      .single();

    if (propErr || !proposal) {
      results.push({
        symbol: signal.symbol, market, signal_id: signal.id,
        proposal_id: null, broker_order_id: null, broker_order_ref: null,
        kernel: null, sizing: null,
        broker_status: "gate_blocked", error: propErr?.message ?? "proposal insert failed",
      });
      continue;
    }

    const proposalId: number = (proposal as any).id;

    // Fail closed: an autonomous market with NO effective daily notional ceiling
    // has unbounded blast radius. Block rather than place an uncapped order.
    if (effectiveDailyNotional == null) {
      await svc.from("trade_proposals")
        .update({ status: "manual_review_required", policy_snapshot: { policy, run_id: runId, block: "no_daily_cap_configured" } })
        .eq("id", proposalId);
      results.push({
        symbol: signal.symbol, market, signal_id: signal.id,
        proposal_id: proposalId, broker_order_id: null, broker_order_ref: null,
        kernel: null, sizing: null, broker_status: "gate_blocked",
        error: `no daily notional cap configured for ${market} — set live_auto_daily_cap_usd (US) or max_daily_notional_inr (India)`,
      });
      continue;
    }

    // Run execution kernel
    const kernel = evaluateAutonomousExecution({
      symbol:                signal.symbol,
      market,
      direction:             signal.direction ?? "long",
      score:                 signal.analyst_score ?? 0,
      evidence_confidence:   (signal as any).confidence ?? 0,
      score_threshold:       scoreThreshold,
      proposed_notional_usd: 0,
      policy,
      current_open_positions: openPositions ?? 0,
      orders_placed_today:    (ordersToday ?? 0) + liveOrdersThisRun,
    });

    if (!kernel.go) {
      await svc.from("trade_proposals")
        .update({ status: "manual_review_required", policy_snapshot: { policy, kernel, run_id: runId } })
        .eq("id", proposalId);
      results.push({
        symbol: signal.symbol, market, signal_id: signal.id,
        proposal_id: proposalId, broker_order_id: null, broker_order_ref: null,
        kernel, sizing: null, broker_status: "gate_blocked", error: kernel.reason,
      });
      continue;
    }

    // Compute sizing
    let currentPrice = 0;
    let priceStale = true;
    try {
      const quote = await getQuote(signal.symbol, svc);
      currentPrice = quote.price ?? 0;
      priceStale = quote.stale || quote.source === "unavailable" || currentPrice <= 0;
    } catch { /* sizing will reject via no_current_price */ }

    const sizing = computeAutonomousSizing({
      nav: liveNav,
      nav_captured_at: navCapturedAt,
      current_price: currentPrice,
      price_stale: priceStale,
      win_rate: winRate,
      payoff_ratio: payoffRatio,
      flat_size_pct: flatSizePct,
      policy,
    });

    if (!sizing.ok) {
      await svc.from("trade_proposals")
        .update({ status: "manual_review_required", policy_snapshot: { policy, kernel, sizing, run_id: runId } })
        .eq("id", proposalId);
      results.push({
        symbol: signal.symbol, market, signal_id: signal.id,
        proposal_id: proposalId, broker_order_id: null, broker_order_ref: null,
        kernel, sizing, broker_status: "sizing_failed", error: sizing.reject_reason,
      });
      continue;
    }

    // Atomic budget reservation — FORBIDDEN to read/sum broker_orders manually here
    let brokerOrderDbId: number | null = null;
    try {
      const { data: rpcResult, error: rpcErr } = await svc.rpc("reserve_live_order_budget_v2", {
        p_proposal_id:       proposalId,
        p_market:            market,
        p_broker:            broker,
        p_broker_env:        "live",
        p_symbol:            signal.symbol,
        p_side:              "buy",
        p_qty:               sizing.proposed_qty,
        p_order_type:        "market",
        p_limit_price:       null,
        p_estimated_notional: sizing.estimated_notional,
        p_currency:          currency,
        p_max_daily_trades:  policy.live_auto_max_orders_per_day ?? cfg.max_daily_trades ?? null,
        p_max_daily_notional: effectiveDailyNotional,
        p_execution_actor:   "autonomous_worker",
      });
      if (rpcErr) throw new Error(rpcErr.message);
      brokerOrderDbId = Number(rpcResult);
    } catch (budgetErr: any) {
      await svc.from("trade_proposals")
        .update({ status: "manual_review_required", policy_snapshot: { policy, kernel, sizing, run_id: runId, budget_error: budgetErr?.message } })
        .eq("id", proposalId);
      results.push({
        symbol: signal.symbol, market, signal_id: signal.id,
        proposal_id: proposalId, broker_order_id: null, broker_order_ref: null,
        kernel, sizing, broker_status: "budget_error", error: budgetErr?.message,
      });
      continue;
    }

    // Submit broker order
    let orderRef: string | null = null;
    let brokerStatus: LiveRunResult["results"][0]["broker_status"] = "needs_reconcile";
    let brokerError: string | undefined;

    if (market === "india") {
      const kiteResult = await placeEquityOrder(
        { tradingsymbol: signal.symbol, transaction_type: "BUY", quantity: sizing.proposed_qty },
        svc,
      );
      if (kiteResult.ok) {
        orderRef = String(kiteResult.data?.order_id ?? "");
        brokerStatus = orderRef ? "submitted" : "needs_reconcile";
      } else {
        brokerStatus = "broker_error";
        brokerError = kiteResult.error;
      }
    } else {
      const rhResult = await rhPlaceMarketOrder(svc, { symbol: signal.symbol, qty: sizing.proposed_qty });
      if (rhResult.ok) {
        orderRef = rhResult.order_id ?? null;
        brokerStatus = rhResult.needs_reconcile ? "needs_reconcile" : "submitted";
        brokerError = rhResult.error;
      } else {
        brokerStatus = "broker_error";
        brokerError = rhResult.error;
      }
    }

    // Update broker_orders with broker result
    const brokerOrderUpdate: Record<string, any> = {};
    if (brokerStatus === "submitted" && orderRef) {
      brokerOrderUpdate.status = "submitted";
      brokerOrderUpdate.broker_order_ref = orderRef;
    } else {
      brokerOrderUpdate.status = "unknown_needs_reconcile";
    }
    await svc.from("broker_orders").update(brokerOrderUpdate).eq("id", brokerOrderDbId);

    // Append immutable audit event
    await svc.from("broker_order_events").insert({
      broker_order_id:  brokerOrderDbId,
      proposal_id:      proposalId,
      event_type:       brokerStatus === "submitted" ? "submitted" : "submit_attempted_reconcile_needed",
      broker,
      broker_order_ref: orderRef,
      actor_kind:       "autonomous_live",
      auto_run_id:      runId,
    });

    // Update proposal final status
    const finalProposalStatus = brokerStatus === "submitted" ? "queued_auto" : "manual_review_required";
    await svc.from("trade_proposals").update({
      status:          finalProposalStatus,
      qty:             sizing.proposed_qty,
      estimated_value: sizing.estimated_notional,
      pct_of_nav:      sizing.pct_of_nav,
      price_at_proposal: currentPrice,
      price_source:    "autonomous_live",
      policy_snapshot: {
        policy, score_threshold: scoreThreshold, run_id: runId,
        run_start: runStart, kernel, sizing,
        broker_status: brokerStatus, broker_order_ref: orderRef,
      },
    }).eq("id", proposalId);

    if (brokerStatus === "submitted") liveOrdersThisRun++;

    results.push({
      symbol: signal.symbol, market, signal_id: signal.id,
      proposal_id: proposalId, broker_order_id: brokerOrderDbId,
      broker_order_ref: orderRef, kernel, sizing, broker_status: brokerStatus,
      error: brokerError,
    });
  }

  const submitted = results.filter((r) => r.broker_status === "submitted").length;
  const reconcileNeeded = results.filter((r) => r.broker_status === "needs_reconcile").length;
  const rejected = results.length - submitted - reconcileNeeded;

  await svc.from("decision_journal").insert({
    entry_type: "autonomous_live_run",
    summary:
      `Live run ${runId}: ${results.length} signal(s) — ` +
      `${submitted} submitted, ${reconcileNeeded} needs_reconcile, ${rejected} blocked/failed. ` +
      `Markets: ${autonomousMarkets.join(",")}. ` +
      `NAV: $${liveNav.toFixed(0)}.`,
  } as any);

  return {
    run_id:           runId,
    evaluated:        results.length,
    submitted,
    rejected,
    reconcile_needed: reconcileNeeded,
    results,
  };
}
