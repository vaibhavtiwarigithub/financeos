// GET /api/research/chart-data?symbols=NVDA,AMZN&indicators=analyst_score,PERatio&days=365&include_trades=true
// Returns time-series per symbol per indicator + optional trade markers.
// Score indicators → signal_score_history. Fundamental indicators → fundamental_facts.
// Price → price_cache. Trade markers → paper_trades (buy entries + sell exits).
import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

const SCORE_COLS = new Set(["analyst_score","fundamental_score","technical_score","sentiment_score","macro_score","insider_score"]);
const PRICE_INDICATOR = "price";
const FUNDAMENTAL_KEYS = new Set(["PERatio","PEGRatio","ReturnOnEquityTTM","GrossMarginTTM","FCFYield","DebtToEquity","QuarterlyRevenueGrowthYOY","ProfitMargin","EPS"]);

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbolsRaw    = sp.get("symbols") ?? "";
  const indicatorsRaw = sp.get("indicators") ?? "analyst_score";
  const days          = Math.min(Math.max(parseInt(sp.get("days") ?? "365"), 30), 2000);
  const includeTrades = sp.get("include_trades") === "true";

  const symbols    = symbolsRaw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
  const indicators = indicatorsRaw.split(",").map(s => s.trim()).filter(Boolean).slice(0, 12);

  if (!symbols.length) return NextResponse.json({ series: {}, trade_markers: {} });

  const cookieStore = await cookies();
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { cookies: { getAll: () => cookieStore.getAll() } },
  );

  const since = new Date(Date.now() - days * 86400000).toISOString();

  const scoreInds = indicators.filter(i => SCORE_COLS.has(i));
  const fundInds  = indicators.filter(i => FUNDAMENTAL_KEYS.has(i));
  const wantPrice = indicators.includes(PRICE_INDICATOR);

  const series: Record<string, Record<string, { date: string; value: number }[]>> = {};
  for (const sym of symbols) series[sym] = {};

  // ── Parallel fetches ────────────────────────────────────────────────────────
  const fetches: PromiseLike<void>[] = [];

  if (scoreInds.length) {
    const cols = ["symbol", "created_at", ...scoreInds].join(", ");
    fetches.push(
      sb.from("signal_score_history")
        .select(cols)
        .in("symbol", symbols)
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .then(({ data }) => {
          for (const row of (data ?? []) as any[]) {
            const sym = row.symbol as string;
            if (!series[sym]) return;
            const date = (row.created_at as string).slice(0, 10);
            for (const ind of scoreInds) {
              if (!series[sym][ind]) series[sym][ind] = [];
              const v = row[ind];
              if (v != null) series[sym][ind].push({ date, value: Number(v) });
            }
          }
        })
    );
  }

  if (fundInds.length) {
    fetches.push(
      sb.from("fundamental_facts")
        .select("symbol, report_period, values")
        .in("symbol", symbols)
        .eq("metric_set", "ttm_overview")
        .gte("report_period", new Date(Date.now() - days * 86400000).toISOString().slice(0, 10))
        .order("report_period", { ascending: true })
        .then(({ data }) => {
          for (const row of data ?? []) {
            const sym = row.symbol as string;
            if (!series[sym]) return;
            const vals = row.values as Record<string, string>;
            const date = row.report_period as string;
            for (const ind of fundInds) {
              const raw = vals?.[ind];
              if (raw == null) continue;
              const v = parseFloat(raw);
              if (!isFinite(v)) continue;
              if (!series[sym][ind]) series[sym][ind] = [];
              series[sym][ind].push({ date, value: v });
            }
          }
        })
    );
  }

  if (wantPrice) {
    fetches.push(
      sb.from("price_cache")
        .select("symbol, date, close")
        .in("symbol", symbols)
        .gte("date", since.slice(0, 10))
        .order("date", { ascending: true })
        .then(({ data }) => {
          for (const row of data ?? []) {
            const sym = row.symbol as string;
            if (!series[sym]) return;
            if (!series[sym][PRICE_INDICATOR]) series[sym][PRICE_INDICATOR] = [];
            series[sym][PRICE_INDICATOR].push({ date: row.date as string, value: Number(row.close) });
          }
        })
    );
  }

  await Promise.all(fetches);

  // ── Trade markers ────────────────────────────────────────────────────────────
  // {symbol: [{date, side, type: "entry"|"exit", analyst_score}]}
  const tradeMarkers: Record<string, { date: string; side: string; type: "entry" | "exit"; analyst_score: number | null }[]> = {};

  if (includeTrades) {
    const { data: trades } = await sb
      .from("paper_trades")
      .select("symbol, order_side, executed_at, exit_at, analyst_score")
      .in("symbol", symbols)
      .gte("executed_at", since)
      .is("tainted", null)
      .order("executed_at", { ascending: true });

    for (const t of (trades ?? []) as any[]) {
      const sym = t.symbol as string;
      if (!tradeMarkers[sym]) tradeMarkers[sym] = [];
      // Entry
      tradeMarkers[sym].push({
        date: (t.executed_at as string).slice(0, 10),
        side: t.order_side,
        type: "entry",
        analyst_score: t.analyst_score != null ? Number(t.analyst_score) : null,
      });
      // Exit (if closed)
      if (t.exit_at) {
        tradeMarkers[sym].push({
          date: (t.exit_at as string).slice(0, 10),
          side: t.order_side === "buy" ? "sell" : "buy",
          type: "exit",
          analyst_score: null,
        });
      }
    }
  }

  return NextResponse.json({ series, trade_markers: tradeMarkers });
}
