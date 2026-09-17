import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/auth/cron";
import { fetchCryptoCandles } from "@/lib/data/crypto-quotes";
import { cryptoCompletedCandles, cryptoSessionDate } from "@/lib/data/crypto-session";
import { decideCryptoExit } from "@/lib/trading/crypto-exit-policy";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Crypto PositionMonitor — Stage 3 (2026-09-16). Deliberately a small standalone
// route, not a branch inside app/api/agents/position-monitor (1200+ lines of
// equity/India-specific trailing-stop, day-low, partial-profit, benchmark, and
// time-review-shadow logic). Mechanical exits only: OHLC-aware stop / target.
// No trailing stop, no partial profit, no benchmark comparison
// (VOO/^NSEI don't apply to a 3-coin crypto book) — future refinement once
// real paper history exists (FEATURE_ARCHITECTURE.md §2.4/§4).
const CRYPTO_SLIP_FRACTION = 0.001;

export async function POST(req: NextRequest) {
  const supabase = createServiceClient();
  try {
    const isCron = verifyCronSecret(req);
    if (!isCron) {
      const userClient = await createClient();
      const { data: { user } } = await userClient.auth.getUser();
      if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let avKey: string | null = null;
    try {
      const { data: vaultRow } = await supabase
        .from("api_key_vault")
        .select("key_value")
        .eq("key_name", "ALPHA_VANTAGE_API_KEY")
        .single();
      avKey = (vaultRow as any)?.key_value ?? process.env.ALPHA_VANTAGE_API_KEY ?? null;
    } catch { avKey = process.env.ALPHA_VANTAGE_API_KEY ?? null; }
    if (!avKey) return NextResponse.json({ skipped: true, reason: "no_av_key" });

    const { data: positions, error: posErr } = await supabase
      .from("paper_positions")
      .select("*")
      .eq("market", "crypto");
    if (posErr) throw new Error(`crypto position read failed: ${posErr.message}`);

    const candleCache = new Map<string, { open: number; high: number; low: number; close: number }>();
    async function latestCandle(symbol: string): Promise<{ open: number; high: number; low: number; close: number } | null> {
      if (candleCache.has(symbol)) return candleCache.get(symbol)!;
      const { candles } = await fetchCryptoCandles(symbol, avKey!);
      const completed = cryptoCompletedCandles(candles);
      const candle = completed.at(-1) ?? null;
      // A missing or late provider bar fails closed. Never evaluate a stop or
      // target from an older daily candle as if it represented this session.
      if (
        !candle || candle.date !== cryptoSessionDate() ||
        !(candle.close > 0) || !(candle.low > 0) || !(candle.high > 0) || !(candle.open > 0)
      ) return null;
      candleCache.set(symbol, candle);
      return candle;
    }

    const closed: any[] = [];
    const updated: any[] = [];
    const unpriced: any[] = [];

    for (const pos of (positions ?? []) as any[]) {
      const symbol = String(pos.symbol).toUpperCase();
      const candle = await latestCandle(symbol);
      if (!candle) { unpriced.push(symbol); continue; }
      const exitReason = decideCryptoExit({
        closePrice: candle.close,
        lowPrice: candle.low,
        highPrice: candle.high,
        stopLoss: pos.stop_loss != null ? Number(pos.stop_loss) : null,
        priceTarget: pos.price_target != null ? Number(pos.price_target) : null,
      });

      if (exitReason) {
        // A stop gaps through at the bar open; otherwise it fills at its stop.
        // A target is deliberately conservative at its stated limit, never the
        // favourable high that may not have been executable.
        const rawExit = exitReason === "stop"
          ? Math.min(candle.open, Number(pos.stop_loss))
          : Number(pos.price_target);
        const exitPrice = parseFloat((rawExit * (1 - CRYPTO_SLIP_FRACTION)).toFixed(2));
        const { data, error } = await supabase.rpc("execute_paper_exit", {
          p_position_id: pos.id, p_exit_price: exitPrice, p_exit_reason: exitReason,
          p_exit_qty: pos.qty, p_partial_stop_loss: null,
        });
        if (error || !(data as any)?.ok) {
          unpriced.push(`${symbol} (exit_failed: ${error?.message ?? (data as any)?.error})`);
          continue;
        }
        closed.push({ symbol, exitReason, exitPrice, realized_pnl: (data as any).realized_pnl });
        continue;
      }

      const highest = Math.max(Number(pos.highest_price ?? candle.close), candle.high);
      await supabase
        .from("paper_positions")
        .update({ current_price: candle.close, highest_price: highest, updated_at: new Date().toISOString() })
        .eq("id", pos.id);
      updated.push({ symbol, price: candle.close });
    }

    // Mark-to-market NAV + one daily paper_performance snapshot per crypto
    // session date (idempotent — matches PositionMonitor's canonical-EOD-writer
    // role for the equity/India books).
    const { data: pool } = await supabase
      .from("paper_portfolio").select("cash_balance").eq("market", "crypto").maybeSingle();
    const { data: openNow } = await supabase
      .from("paper_positions").select("qty, current_price").eq("market", "crypto");
    const positionsValue = (openNow ?? []).reduce(
      (s: number, p: any) => s + Number(p.qty) * Number(p.current_price ?? 0), 0,
    );
    const cash = Number((pool as any)?.cash_balance ?? 0);
    const nav = cash + positionsValue;
    const today = cryptoSessionDate();

    await supabase.from("paper_portfolio").update({ nav, updated_at: new Date().toISOString() }).eq("market", "crypto");

    const { data: existingPerf } = await supabase
      .from("paper_performance").select("id").eq("market", "crypto").eq("date", today).maybeSingle();
    if (!existingPerf) {
      const { data: seedRow } = await supabase
        .from("paper_performance").select("nav").eq("market", "crypto").order("date", { ascending: true }).limit(1).maybeSingle();
      const seedNav = Number((seedRow as any)?.nav ?? 10000);
      const { data: yesterdayRow } = await supabase
        .from("paper_performance").select("nav").eq("market", "crypto").order("date", { ascending: false }).limit(1).maybeSingle();
      const dailyPnl = yesterdayRow ? nav - Number((yesterdayRow as any).nav) : 0;
      const { data: closedTrades } = await supabase
        .from("paper_trades").select("outcome").eq("market", "crypto").not("outcome", "is", null);
      const wins = (closedTrades ?? []).filter((t: any) => t.outcome === "win").length;
      const losses = (closedTrades ?? []).filter((t: any) => t.outcome === "loss").length;
      const total = wins + losses;
      await supabase.from("paper_performance").insert({
        date: today, market: "crypto", nav, cash_balance: cash, positions_value: positionsValue,
        daily_pnl: dailyPnl, total_pnl: nav - seedNav,
        total_pnl_pct: seedNav > 0 ? ((nav - seedNav) / seedNav) * 100 : 0,
        win_count: wins, loss_count: losses, win_rate: total > 0 ? wins / total : 0,
      });
    }

    return NextResponse.json({ success: true, closed, updated, unpriced, nav });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function GET(req: NextRequest) { return POST(req); }
