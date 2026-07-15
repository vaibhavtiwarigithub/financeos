import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/auth/cron";
import { requireOwner } from "@/lib/auth/require-owner";
import { fetchUsCandles } from "@/lib/data/candles";
import { computeFillPrice, getQuote } from "@/lib/data/quotes";
import { createServiceClient } from "@/lib/supabase/service";
import {
  buildHedgeMarketSnapshot,
  cooldownState,
  evaluateDownsideHedge,
  type HedgeConfig,
  type HedgeState,
} from "@/lib/trading/downside-hedge";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function gate(req: NextRequest) {
  if (verifyCronSecret(req)) return null;
  return requireOwner();
}

const configOf = (r: any): HedgeConfig => ({
  enabled: !!r.enabled,
  allowedSymbols: Array.isArray(r.allowed_symbols) ? r.allowed_symbols.map(String) : [],
  entryDangerScore: Number(r.entry_danger_score),
  exitDangerScore: Number(r.exit_danger_score),
  entryConfirmations: Number(r.entry_confirmations),
  exitConfirmations: Number(r.exit_confirmations),
  entryReturn20Pct: Number(r.entry_return_20_pct),
  entryDrawdown20Pct: Number(r.entry_drawdown_20_pct),
  maxHoldingDays: Number(r.max_holding_days),
  cooldownDays: Number(r.cooldown_days),
});

const stateOf = (r: any): HedgeState => ({
  state: r.state,
  entryStreak: Number(r.entry_streak ?? 0),
  exitStreak: Number(r.exit_streak ?? 0),
  activeSymbol: r.active_symbol ?? null,
  activeSince: r.active_since ?? null,
  cooldownUntil: r.cooldown_until ?? null,
});

export async function POST(req: NextRequest) {
  const denied = await gate(req);
  if (denied) return denied;
  const svc = createServiceClient();
  const now = new Date().toISOString();

  try {
    const [{ data: cfg, error: cfgError }, { data: state, error: stateError }] = await Promise.all([
      svc.from("downside_hedge_config").select("*").eq("market", "us").single(),
      svc.from("downside_hedge_state").select("*").eq("market", "us").single(),
    ]);
    if (cfgError || stateError || !cfg || !state) {
      return NextResponse.json({ ok: false, error: cfgError?.message ?? stateError?.message ?? "hedge_config_missing" }, { status: 503 });
    }

    const { data: openHedge } = await svc.from("paper_positions")
      .select("symbol,created_at")
      .eq("market", "us").eq("position_role", "hedge").maybeSingle();

    // Reconcile database truth before evaluating. A position is authoritative;
    // stale controller state must never permit a second hedge.
    let current = stateOf(state);
    if (openHedge && current.state !== "active" && current.state !== "exit_pending") {
      current = { ...current, state: "active", activeSymbol: openHedge.symbol, activeSince: openHedge.created_at };
    } else if (!openHedge && (current.state === "active" || current.state === "exit_pending")) {
      current = cooldownState(now, Number(cfg.cooldown_days));
    }

    if (!cfg.enabled && !openHedge) {
      if (current.state !== "off") {
        await svc.from("downside_hedge_state").update({
          state: "off", entry_streak: 0, exit_streak: 0, active_symbol: null,
          active_since: null, cooldown_until: null, last_reason: "disabled", updated_at: now,
        }).eq("market", "us");
      }
      return NextResponse.json({ ok: true, skipped: true, reason: "disabled", paper_execute_enabled: false });
    }

    const { data: macro } = await svc.from("macro_regime")
      .select("danger_score,week_of,regime").order("week_of", { ascending: false }).limit(1).maybeSingle();
    const macroAge = macro?.week_of ? Date.now() - new Date(`${macro.week_of}T23:59:59Z`).getTime() : Infinity;
    const [spy, qqq] = await Promise.all([
      fetchUsCandles("SPY", async () => [], 50),
      fetchUsCandles("QQQ", async () => [], 21),
    ]);
    const snapshot = buildHedgeMarketSnapshot(spy.candles, qqq.candles, Number(macro?.danger_score), now);
    if (!snapshot || macroAge < 0 || macroAge > 10 * 86_400_000) {
      await svc.from("downside_hedge_events").insert({
        market: "us", event_type: "error", decision: "none", state_before: current.state,
        state_after: current.state, symbol: current.activeSymbol,
        reason: "macro or market data unavailable/stale",
        inputs: { macro_week: macro?.week_of ?? null, spy_source: spy.source, qqq_source: qqq.source },
        config_snapshot: cfg,
      });
      return NextResponse.json({ ok: true, skipped: true, reason: "data_unavailable_or_stale" });
    }

    const observationDate = spy.candles.at(-1)!.date;
    if (state.last_observation_date === observationDate) {
      return NextResponse.json({ ok: true, skipped: true, reason: "observation_already_evaluated", observation_date: observationDate });
    }

    const effectiveConfig = configOf(cfg);
    if (openHedge) effectiveConfig.enabled = true;
    const decision = evaluateDownsideHedge(effectiveConfig, current, snapshot);
    const inputs = { ...snapshot, observationDate, spySource: spy.source, qqqSource: qqq.source, macroWeek: macro.week_of };
    const { data: recorded, error: recordError } = await svc.rpc("record_downside_hedge_evaluation", {
      p_expected_updated_at: state.updated_at, p_observation_date: observationDate,
      p_decision: decision.action, p_state_before: current.state, p_state_after: decision.next.state,
      p_entry_streak: decision.next.entryStreak, p_exit_streak: decision.next.exitStreak,
      p_symbol: decision.next.activeSymbol, p_active_since: decision.next.activeSince,
      p_cooldown_until: decision.next.cooldownUntil, p_reason: decision.reason,
      p_inputs: inputs, p_config_snapshot: cfg,
    });
    if (recordError) throw new Error(`hedge evaluation transaction failed: ${recordError.message}`);
    if (!(recorded as any)?.ok) {
      return NextResponse.json({ ok: true, skipped: true, reason: (recorded as any)?.error ?? "concurrent_evaluation" });
    }
    const event = { id: (recorded as any).event_id };

    let execution: any = { attempted: false, reason: "shadow_only" };
    if (cfg.paper_execute_enabled && decision.action === "enter" && decision.symbol) {
      const quote = await getQuote(decision.symbol, svc);
      if (quote.price <= 0 || quote.stale || quote.source === "unavailable") {
        execution = { attempted: false, reason: "quote_unavailable_or_stale" };
      } else {
        const [{ data: pool }, { data: positions }] = await Promise.all([
          svc.from("paper_portfolio").select("cash_balance,nav").eq("market", "us").single(),
          svc.from("paper_positions").select("qty,current_price,avg_cost").eq("market", "us"),
        ]);
        const nav = Number(pool?.cash_balance ?? 0) + (positions ?? []).reduce(
          (sum: number, p: any) => sum + Number(p.qty) * Number(p.current_price ?? p.avg_cost), 0);
        const fillPrice = computeFillPrice(quote);
        const qty = Math.floor((nav * Number(cfg.target_nav_pct) / 100) / fillPrice);
        if (qty < 1) {
          execution = { attempted: false, reason: "target_below_one_share" };
        } else {
          const { data: signal, error: signalError } = await svc.from("agent_signals").insert({
            symbol: decision.symbol, market: "us", direction: "long", analyst_score: 0,
            conviction: 100, agent_type: "downside_hedge", agent_label: "downside_hedge",
            status: "claiming", claimed_at: now, score_source: "hedge_control_v1",
            scoring_version: "hedge_v1", rationale: decision.reason,
          }).select("id").single();
          if (signalError) throw new Error(`hedge control signal failed: ${signalError.message}`);
          const { data: fill, error: fillError } = await svc.rpc("execute_paper_hedge_fill", {
            p_event_id: event.id, p_signal_id: signal.id, p_symbol: decision.symbol, p_qty: qty,
            p_expected_price: quote.price, p_fill_price: fillPrice, p_price_source: quote.source,
            p_price_retrieved_at: quote.retrievedAt, p_bid: quote.bid, p_ask: quote.ask,
            p_spread: quote.ask && quote.bid ? quote.ask - quote.bid : null,
          });
          if (fillError || !(fill as any)?.ok) {
            await svc.from("agent_signals").update({ status: "rejected", claimed_at: null }).eq("id", signal.id);
          }
          execution = { attempted: true, result: fillError ? { ok: false, error: fillError.message } : fill };
        }
      }
    } else if (cfg.paper_execute_enabled && decision.action === "exit" && decision.symbol) {
      const { data: result, error } = await svc.rpc("request_paper_hedge_exit", { p_event_id: event.id, p_symbol: decision.symbol });
      execution = { attempted: true, result: error ? { ok: false, error: error.message } : result };
    }

    return NextResponse.json({ ok: true, observation_date: observationDate, decision, execution });
  } catch (error: any) {
    await svc.from("downside_hedge_events").insert({
      market: "us", event_type: "error", decision: "none", reason: String(error?.message ?? error).slice(0, 500),
    }).catch(() => {});
    return NextResponse.json({ ok: false, error: error?.message ?? "downside_hedge_failed" }, { status: 500 });
  }
}
