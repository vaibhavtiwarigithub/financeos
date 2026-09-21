import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth/require-owner";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { checkKillSwitches } from "@/lib/kill-switches";
import { isPaused, isTradingEnabled } from "@/lib/market-controls";
import { CRYPTO_SYMBOLS } from "@/lib/scoring/instrument-taxonomy";
import { fetchCryptoCandles } from "@/lib/data/crypto-quotes";
import { cryptoCompletedCandles, cryptoSessionDate } from "@/lib/data/crypto-session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Crypto PaperTrader — Stage 3 (2026-09-16, owner-approved evidence-gate
// override). Deliberately NOT threaded through app/api/agents/paper-trade —
// that route's portfolio constructor, correlation shadow, capital rotation,
// and Kelly/genome sizing are all calibrated on equity payoff/volatility
// distributions and keyed to market:"us"|"india" through half a dozen library
// functions backed by market-CHECK-constrained tables (trading_mandates,
// market_controls pre-migration, strategy_validation_automation). Forking that
// router for a third book is a much larger, riskier change than Stage 3 paper
// trading needs. This is a small, separate, flat-sizing path:
//   - own pool: paper_portfolio/positions/trades/performance market='crypto'
//     (see supabase/migrations/20260916020000_crypto_paper_pool.sql)
//   - no sector caps, no correlation shadow, no capital rotation, no
//     calibrated Kelly sizing, no genome — flat % of crypto-pool NAV
//   - price = latest COMPLETED independent public daily candle (Coinbase first,
//     Kraken second; Alpha Vantage only as a fallback — lib/data/crypto-quotes.ts)
//   - one position per coin (3 coins total: BTC/ETH/SOL)
// Genome/portfolio-constructor parity is a future decision once real paper
// history exists, not guessed here (doc §2.4).
const CRYPTO_MANDATE = {
  version: "crypto-v1-static",
  stop_loss_pct: 15,
  target_pct: 25,
  target_hold_days: 10,
  score_threshold: 60,
} as const;
const MAX_OPEN_CRYPTO_NAMES = CRYPTO_SYMBOLS.size; // one per coin, 3 coins total
// No live bid/ask for AV daily candles — same fixed slip-fraction fallback
// already used for India fills (lib/analytics/performance-metrics.MODELED_SLIP_FRACTION).
const CRYPTO_SLIP_FRACTION = 0.001;

export async function POST(req: NextRequest) {
  const supabase = createServiceClient();
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const gate = await requireOwner();
      if (gate) return gate;
    }

    if (await isPaused(supabase, "crypto")) {
      return NextResponse.json({ skipped: true, reason: "crypto book paused" });
    }
    if (!(await isTradingEnabled(supabase, "crypto"))) {
      return NextResponse.json({ skipped: true, reason: "crypto trading disabled" });
    }
    const ks = await checkKillSwitches(supabase, { market: "crypto", book: "paper" });
    if (!ks.safe) {
      return NextResponse.json({ skipped: true, reason: ks.reason });
    }

    const { data: cfg } = await supabase
      .from("strategy_config")
      .select("position_size_pct")
      .limit(1)
      .maybeSingle();
    // Only 3 possible names — cap higher than the equity 15% single-position
    // limit is reasonable, but still bounded, not "all-in on one coin".
    const positionSizePct = Math.min(33, (cfg as any)?.position_size_pct ?? 10);

    const { data: pool } = await supabase
      .from("paper_portfolio")
      .select("cash_balance, nav")
      .eq("market", "crypto")
      .maybeSingle();
    if (!pool) {
      return NextResponse.json(
        { error: "no_crypto_pool — run supabase/migrations/20260916020000_crypto_paper_pool.sql" },
        { status: 500 },
      );
    }
    let cashRemaining = Number((pool as any).cash_balance);
    const nav = Number((pool as any).nav);

    const { data: openPos } = await supabase
      .from("paper_positions")
      .select("symbol")
      .eq("market", "crypto");
    const openNames = new Set((openPos ?? []).map((p: any) => String(p.symbol).toUpperCase()));

    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const { data: signals, error: sigErr } = await supabase
      .from("agent_signals")
      .select("*")
      .eq("market", "us")
      .in("symbol", [...CRYPTO_SYMBOLS])
      .eq("direction", "long")
      .eq("status", "pending")
      .eq("session_validated", true)
      .eq("score_source", "crypto_native_shadow_v1")
      .gte("analyst_score", CRYPTO_MANDATE.score_threshold)
      .gte("created_at", since)
      .order("analyst_score", { ascending: false });
    if (sigErr) throw new Error(`crypto signal query failed: ${sigErr.message}`);

    let avKey: string | null = null;
    try {
      const { data: vaultRow } = await supabase
        .from("api_key_vault")
        .select("key_value")
        .eq("key_name", "ALPHA_VANTAGE_API_KEY")
        .single();
      avKey = (vaultRow as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? null;
    } catch { avKey = process.env.ALPHA_VANTAGE_API_KEY ?? null; }

    const filled: any[] = [];
    const skipped: any[] = [];

    for (const signal of (signals ?? []) as any[]) {
      const symbol = String(signal.symbol).toUpperCase();
      if (openNames.has(symbol)) { skipped.push({ symbol, reason: "open_position_exists" }); continue; }
      if (openNames.size >= MAX_OPEN_CRYPTO_NAMES) { skipped.push({ symbol, reason: "max_open_names" }); continue; }

      const { data: claimed } = await supabase
        .from("agent_signals")
        .update({ status: "claiming", claimed_at: new Date().toISOString() })
        .eq("id", signal.id).eq("status", "pending").select("id");
      if (!claimed || claimed.length === 0) continue;
      const revertClaim = async () => {
        await supabase.from("agent_signals")
          .update({ status: "pending", claimed_at: null })
          .eq("id", signal.id).eq("status", "claiming");
      };

      // Coinbase/Kraken are the normal path. Alpha Vantage is optional fallback
      // only, so a shared-equity quota/key cannot disable crypto paper research.
      const { candles, source } = await fetchCryptoCandles(symbol, avKey ?? "");
      const completed = cryptoCompletedCandles(candles);
      const last = completed.at(-1);
      // A stale daily bar is not a valid entry price. The signal and fill must
      // refer to the same fully closed UTC session, otherwise the claim is
      // released and no paper position is manufactured from old data.
      if (!last || last.date !== cryptoSessionDate() || !(last.close > 0)) {
        await revertClaim();
        skipped.push({ symbol, reason: "price_unavailable_or_stale" });
        continue;
      }

      const price = last.close;
      const fillPrice = parseFloat((price * (1 + CRYPTO_SLIP_FRACTION)).toFixed(2));
      const spend = Math.min(cashRemaining, nav * (positionSizePct / 100));
      const qty = spend / fillPrice;
      const totalCost = qty * fillPrice;
      if (!(qty > 0) || totalCost > cashRemaining) {
        await revertClaim();
        skipped.push({ symbol, reason: "insufficient_cash" });
        continue;
      }

      const priceTarget = parseFloat((fillPrice * (1 + CRYPTO_MANDATE.target_pct / 100)).toFixed(2));
      const stopLoss = parseFloat((fillPrice * (1 - CRYPTO_MANDATE.stop_loss_pct / 100)).toFixed(2));
      const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

      const { data: rpcData, error: rpcErr } = await supabase.rpc("execute_paper_fill", {
        p_signal_id: signal.id, p_market: "crypto", p_currency: "USD", p_symbol: symbol,
        p_qty: qty, p_fill_price: fillPrice, p_total_cost: totalCost, p_price_source: source,
        p_price_retrieved_at: new Date().toISOString(), p_bid: null, p_ask: null, p_spread: CRYPTO_SLIP_FRACTION,
        p_analyst_score: signal.analyst_score, p_strategy_id: signal.source ?? "research",
        p_notes: signal.rationale?.slice(0, 500) ?? null,
        p_rationale: `${signal.rationale ?? ""} [source: ${source}, crypto paper Stage 3]`,
        p_price_target: priceTarget, p_stop_loss: stopLoss, p_sector: null,
        p_expected_price: price,
        p_mandate_id: null, p_mandate_version: CRYPTO_MANDATE.version,
        p_mandate_snapshot: CRYPTO_MANDATE, p_resolved_horizon_days: CRYPTO_MANDATE.target_hold_days,
        p_max_open_names: MAX_OPEN_CRYPTO_NAMES, p_max_sector_names: MAX_OPEN_CRYPTO_NAMES,
        p_per_trade_cap: null, p_daily_notional_cap: null, p_day_start: dayStart,
      } as any);

      if (rpcErr || !(rpcData as any)?.ok) {
        await revertClaim();
        skipped.push({ symbol, reason: rpcErr ? `rpc_error:${rpcErr.message}` : `rpc_denied:${(rpcData as any)?.error}` });
        continue;
      }
      openNames.add(symbol);
      cashRemaining -= totalCost;
      filled.push({ symbol, qty, price: fillPrice });
    }

    return NextResponse.json({ success: true, filled, skipped });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
