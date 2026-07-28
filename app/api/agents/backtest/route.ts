import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { fetchYahooCandles } from "@/lib/india-data";

export const dynamic = "force-dynamic";

// INFORMATIONAL BACKTEST ONLY — results are NOT eligible for strategy promotion.
// This engine uses in-sample data (same signals used to train the screener) and does not
// implement point-in-time datasets, purged walk-forward validation, or a locked holdout.
// gate_pass in the response is for informational display only — it cannot authorize
// promotion of a strategy_version to 'eligible' or 'approved_live'.
// Replace with Python Validation Engine (Phase 2) before any eligibility decisions.

interface TradeOutcome {
  symbol: string;
  signal_date: string;
  entry_price: number;
  exit_price: number;
  exit_reason: "target" | "stop" | "timeout" | "exit_signal";
  hold_days: number;
  return_pct: number;
  analyst_score: number;
}

interface BacktestMetrics {
  total_trades: number;
  win_rate: number;
  avg_return_pct: number;
  median_return_pct: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  expectancy: number;         // avg_win * win_rate - avg_loss * loss_rate
  avg_hold_days: number;
  benchmark_return_pct: number | null;
  benchmark_symbol: string;   // "SPY" | "^NSEI"
  alpha_pct: number | null;
  market: "us" | "india";
  currency: string;           // "$" | "₹"
  gate_pass: boolean;
  gate_reasons: Record<string, { pass: boolean; value: number | null; threshold: number | null }>;
  outcomes: TradeOutcome[];
}

function computeMedian(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function computeMaxDrawdown(returns: number[]): number {
  let peak = 1, maxDD = 0, nav = 1;
  for (const r of returns) {
    nav *= (1 + r / 100);
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

function computeSharpe(returns: number[], riskFreeRate = 0.05): number {
  if (returns.length < 2) return 0;
  const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avg, 2), 0) / (returns.length - 1));
  if (std === 0) return 0;
  // Annualize assuming ~252/avg_hold_days periods per year
  const periodsPerYear = 252;
  const annualizedReturn = avg * periodsPerYear;
  const annualizedStd = std * Math.sqrt(periodsPerYear);
  return (annualizedReturn - riskFreeRate * 100) / annualizedStd;
}

// Eligibility gate thresholds (from architecture doc)
const GATE = {
  min_trades:         20,
  min_expectancy:     0,     // must be positive
  min_sharpe:         0.5,
  max_drawdown_pct:   25,
  min_win_rate:       0.40,
};

export async function POST(req: NextRequest) {
  try {
    const userClient = await createClient();
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const supabase = createServiceClient();
    const body = await req.json().catch(() => ({}));
    const {
      strategy_version_id,
      date_from,
      date_to,
      score_threshold = 60,
      target_pct = 20,
      stop_loss_pct = 7,
      max_hold_days = 15,
      market: bodyMarket,
    } = body as {
      strategy_version_id?: number;
      date_from?: string;
      date_to?: string;
      score_threshold?: number;
      target_pct?: number;
      stop_loss_pct?: number;
      max_hold_days?: number;
      market?: "us" | "india";
    };

    // Market scope: body wins, else `mkt` cookie, else US. India replays ₹ signals
    // against Yahoo `.NS` candles; US replays against price_cache (unchanged).
    const cookieMkt = (await cookies()).get("mkt")?.value;
    const market: "us" | "india" = (bodyMarket ?? cookieMkt) === "india" ? "india" : "us";
    const currency = market === "india" ? "₹" : "$";

    // Pull qualifying long signals in date range, scoped to market. Pre-057 the
    // `market` column doesn't exist → the .eq errors, so we retry unscoped and
    // behave exactly as before (US book).
    function buildSignalsQuery(scoped: boolean) {
      let q = supabase
        .from("agent_signals")
        .select("id, symbol, direction, analyst_score, created_at, asset_class")
        .eq("direction", "long")
        .gte("analyst_score", score_threshold)
        .order("created_at", { ascending: true });
      if (scoped) q = q.eq("market", market);
      if (date_from) q = q.gte("created_at", date_from);
      if (date_to)   q = q.lte("created_at", date_to);
      return q.limit(500);
    }

    let { data: signals, error: sigErr } = await buildSignalsQuery(true);
    if (sigErr) ({ data: signals, error: sigErr } = await buildSignalsQuery(false));
    if (sigErr) return NextResponse.json({ error: sigErr.message }, { status: 500 });
    if (!signals?.length) return NextResponse.json({ error: "No qualifying signals in date range" }, { status: 404 });

    const symbols: string[] = [...new Set((signals as any[]).map((s) => String(s.symbol)))];

    // Build price lookup: symbol → sorted candle array (oldest first).
    const priceMap: Record<string, { date: string; close: number }[]> = {};
    // Benchmark daily closes by date: SPY for US, NIFTY (^NSEI) for India.
    const benchPrices: Record<string, number> = {};
    const benchSymbol = market === "india" ? "^NSEI" : "SPY";

    if (market === "india") {
      // India: source `.NS` candles from free Yahoo (price_cache is US-only).
      const candleArrays = await Promise.all(symbols.map(s => fetchYahooCandles(s, "2y")));
      symbols.forEach((sym, i) => {
        priceMap[sym] = candleArrays[i].map(c => ({ date: c.date, close: c.close }));
      });
      const nifty = await fetchYahooCandles("^NSEI", "2y");
      for (const c of nifty) benchPrices[c.date] = c.close;
    } else {
      // US: price_cache candles (unchanged path).
      const { data: candles } = await supabase
        .from("price_cache")
        .select("symbol, date, close, open, high, low")
        .in("symbol", symbols)
        .order("date", { ascending: true });
      for (const c of candles ?? []) {
        if (!priceMap[c.symbol]) priceMap[c.symbol] = [];
        priceMap[c.symbol].push({ date: c.date, close: parseFloat(c.close) });
      }
      const { data: spyCandles } = await supabase
        .from("price_cache")
        .select("date, close")
        .eq("symbol", "SPY")
        .order("date", { ascending: true });
      for (const c of spyCandles ?? []) benchPrices[c.date] = parseFloat(c.close);
    }

    const outcomes: TradeOutcome[] = [];

    for (const signal of signals as any[]) {
      const signalDate = signal.created_at.split("T")[0];
      const candles = priceMap[signal.symbol] ?? [];

      // Find entry: first candle on or after signal date
      const entryIdx = candles.findIndex(c => c.date >= signalDate);
      if (entryIdx < 0 || entryIdx >= candles.length - 1) continue;

      const entryPrice = candles[entryIdx].close;
      if (entryPrice <= 0) continue;

      const targetPrice   = entryPrice * (1 + target_pct / 100);
      const stopPrice     = entryPrice * (1 - stop_loss_pct / 100);
      const maxExitIdx    = Math.min(entryIdx + max_hold_days, candles.length - 1);

      let exitPrice = candles[maxExitIdx].close;
      let exitReason: TradeOutcome["exit_reason"] = "timeout";
      let holdDays = 0;

      for (let i = entryIdx + 1; i <= maxExitIdx; i++) {
        const c = candles[i];
        holdDays = i - entryIdx;
        if (c.close >= targetPrice) { exitPrice = c.close; exitReason = "target"; break; }
        if (c.close <= stopPrice)   { exitPrice = c.close; exitReason = "stop";   break; }
        if (i === maxExitIdx)        { exitPrice = c.close; exitReason = "timeout"; }
      }

      const returnPct = (exitPrice - entryPrice) / entryPrice * 100;

      outcomes.push({
        symbol:        signal.symbol,
        signal_date:   signalDate,
        entry_price:   parseFloat(entryPrice.toFixed(4)),
        exit_price:    parseFloat(exitPrice.toFixed(4)),
        exit_reason:   exitReason,
        hold_days:     holdDays,
        return_pct:    parseFloat(returnPct.toFixed(4)),
        analyst_score: signal.analyst_score,
      });
    }

    if (outcomes.length === 0) {
      return NextResponse.json({
        error: market === "india"
          ? "No trades could be simulated — no Yahoo .NS candles for the signalled India symbols in range"
          : "No trades could be simulated — missing price_cache data",
      }, { status: 404 });
    }

    const returns = outcomes.map(o => o.return_pct);
    const wins    = returns.filter(r => r > 0);
    const losses  = returns.filter(r => r <= 0);

    const win_rate        = wins.length / returns.length;
    const avg_return_pct  = returns.reduce((a, b) => a + b, 0) / returns.length;
    const median_return   = computeMedian(returns);
    const max_drawdown    = computeMaxDrawdown(returns);
    const sharpe          = computeSharpe(returns);
    const avg_win         = wins.length  ? wins.reduce((a, b) => a + b, 0)  / wins.length  : 0;
    const avg_loss        = losses.length ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
    const expectancy      = avg_win * win_rate - avg_loss * (1 - win_rate);
    const avg_hold_days   = outcomes.reduce((s, o) => s + o.hold_days, 0) / outcomes.length;

    // Benchmark return over same period: SPY (US) or NIFTY 50 (India).
    const firstDate = outcomes[0].signal_date;
    const lastDate  = outcomes[outcomes.length - 1].signal_date;
    const benchStart  = benchPrices[firstDate] ?? null;
    const benchEnd    = benchPrices[lastDate]  ?? null;
    const benchmark_return_pct = (benchStart && benchEnd)
      ? parseFloat(((benchEnd - benchStart) / benchStart * 100).toFixed(4))
      : null;
    const alpha_pct = benchmark_return_pct != null
      ? parseFloat((avg_return_pct - benchmark_return_pct).toFixed(4))
      : null;

    // Eligibility gate
    const gate_reasons = {
      min_trades:     { pass: outcomes.length >= GATE.min_trades,   value: outcomes.length,  threshold: GATE.min_trades },
      min_expectancy: { pass: expectancy > GATE.min_expectancy,      value: expectancy,       threshold: GATE.min_expectancy },
      min_sharpe:     { pass: sharpe >= GATE.min_sharpe,             value: sharpe,           threshold: GATE.min_sharpe },
      max_drawdown:   { pass: max_drawdown <= GATE.max_drawdown_pct, value: max_drawdown,     threshold: GATE.max_drawdown_pct },
      min_win_rate:   { pass: win_rate >= GATE.min_win_rate,         value: win_rate,         threshold: GATE.min_win_rate },
    };
    const gate_pass = Object.values(gate_reasons).every(g => g.pass);

    const metrics: BacktestMetrics = {
      total_trades: outcomes.length,
      win_rate:         parseFloat(win_rate.toFixed(4)),
      avg_return_pct:   parseFloat(avg_return_pct.toFixed(4)),
      median_return_pct: parseFloat(median_return.toFixed(4)),
      max_drawdown_pct: parseFloat(max_drawdown.toFixed(4)),
      sharpe_ratio:     parseFloat(sharpe.toFixed(4)),
      expectancy:       parseFloat(expectancy.toFixed(4)),
      avg_hold_days:    parseFloat(avg_hold_days.toFixed(1)),
      benchmark_return_pct,
      benchmark_symbol: benchSymbol,
      alpha_pct,
      market,
      currency,
      gate_pass,
      gate_reasons,
      outcomes,
    };

    // Persist experiment run if strategy_version_id provided.
    // gate_pass is stored as informational only — status is always 'informational',
    // never 'complete', to prevent this result from being used for eligibility decisions.
    if (strategy_version_id) {
      await supabase.from("experiment_runs").insert({
        strategy_version_id,
        run_type:   "backtest_informational",
        dataset_from: date_from ?? outcomes[0].signal_date,
        dataset_to:   date_to   ?? outcomes[outcomes.length - 1].signal_date,
        symbol_universe: symbols,
        signal_count:    outcomes.length,
        win_rate,
        avg_return_pct,
        median_return_pct: median_return,
        max_drawdown_pct:  max_drawdown,
        sharpe_ratio:      sharpe,
        expectancy,
        benchmark_symbol:       benchSymbol,
        benchmark_return_pct,
        alpha_pct,
        gate_pass,
        gate_reasons,
        metrics_json: metrics,
        config_snapshot: { score_threshold, target_pct, stop_loss_pct, max_hold_days },
        status:      "informational",
        completed_at: new Date().toISOString(),
      });
    }

    return NextResponse.json({
      success: true,
      metrics,
      eligible_for_promotion: false,
      warning: "This backtest uses in-sample data and is informational only. Strategy promotion requires the Python Validation Engine with point-in-time data and a locked holdout (Phase 2).",
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
