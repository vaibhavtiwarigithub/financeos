import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Macro regimes by date range — used to tag each trade at the time of decision
const MACRO_REGIMES: { start: string; end: string; regime: string; event_tag: string }[] = [
  { start: "2000-01-01", end: "2007-10-08", regime: "Bull Market",         event_tag: "dot-com_recovery_housing_boom" },
  { start: "2007-10-09", end: "2009-03-09", regime: "Financial Crisis",    event_tag: "gfc_lehman_collapse" },
  { start: "2009-03-10", end: "2020-02-18", regime: "QE Bull Run",         event_tag: "post-gfc_qe_expansion" },
  { start: "2020-02-19", end: "2020-03-23", regime: "COVID Crash",         event_tag: "covid_crash" },
  { start: "2020-03-24", end: "2021-11-30", regime: "Stimulus Bull",       event_tag: "stimulus_bull_zero_rates" },
  { start: "2021-12-01", end: "2021-12-31", regime: "Inflation Rising",    event_tag: "inflation_surge_transition" },
  { start: "2022-01-01", end: "2023-07-26", regime: "Rate Hike Cycle",     event_tag: "fed_rate_hike_cycle_400bps" },
  { start: "2023-07-27", end: "2024-09-17", regime: "Rate Pause / AI Bull",event_tag: "ai_boom_rate_pause" },
  { start: "2024-09-18", end: "2025-12-31", regime: "Rate Cut Cycle",      event_tag: "rate_cut_tariff_uncertainty" },
  { start: "2026-01-01", end: "2099-12-31", regime: "Current",             event_tag: "current" },
];

function getRegime(dateStr: string): { regime: string; event_tag: string } {
  for (const r of MACRO_REGIMES) {
    if (dateStr >= r.start && dateStr <= r.end) return { regime: r.regime, event_tag: r.event_tag };
  }
  return { regime: "Unknown", event_tag: "unknown" };
}

// Find the closest available date in a price series (within ±5 trading days)
function findClosestPrice(series: Record<string, number>, targetDate: string): number | null {
  if (series[targetDate]) return series[targetDate];
  for (let offset = 1; offset <= 7; offset++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() + offset);
    const k = d.toISOString().slice(0, 10);
    if (series[k]) return series[k];
    const d2 = new Date(targetDate);
    d2.setDate(d2.getDate() - offset);
    const k2 = d2.toISOString().slice(0, 10);
    if (series[k2]) return series[k2];
  }
  return null;
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

async function fetchDailySeries(symbol: string, avKey: string): Promise<Record<string, number>> {
  try {
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=full&apikey=${avKey}`;
    const r = await fetch(url, { next: { revalidate: 3600 } });
    const json = await r.json();
    const series = json["Time Series (Daily)"];
    if (!series) return {};
    const result: Record<string, number> = {};
    for (const [date, val] of Object.entries(series as Record<string, any>)) {
      result[date] = parseFloat(val["5. adjusted close"] ?? val["4. close"] ?? "0");
    }
    return result;
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest) {
  const svc = createServiceClient();
  const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? "";

  const body = await req.json().catch(() => ({}));
  const limit = Math.min(body?.limit ?? 200, 500);

  // Load pending decisions
  const { data: pending, error } = await svc
    .from("trade_decisions")
    .select("*")
    .eq("enrichment_status", "pending")
    .order("exec_date", { ascending: true })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!pending || pending.length === 0) return NextResponse.json({ enriched: 0, message: "No pending decisions" });

  // Group by symbol to minimize AV API calls
  const bySymbol: Record<string, any[]> = {};
  for (const d of pending) {
    if (!bySymbol[d.symbol]) bySymbol[d.symbol] = [];
    bySymbol[d.symbol].push(d);
  }

  const symbols = Object.keys(bySymbol);
  const results = { enriched: 0, no_data: 0, errors: 0 };

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i];
    if (i > 0) await new Promise(r => setTimeout(r, 350)); // AV rate limit

    const series = await fetchDailySeries(symbol, avKey);
    const hasData = Object.keys(series).length > 0;

    for (const decision of bySymbol[symbol]) {
      try {
        const execDate: string = decision.exec_date;
        const execPrice: number = parseFloat(decision.exec_price);
        const action: string = decision.action; // 'buy' | 'sell'
        const { regime, event_tag } = getRegime(execDate);

        if (!hasData) {
          await svc.from("trade_decisions").update({
            enrichment_status: "no_data",
            macro_market_regime: regime,
            macro_event_tag: event_tag,
            price_data_available: false,
          }).eq("id", decision.id);
          results.no_data++;
          continue;
        }

        const price1d  = findClosestPrice(series, addDays(execDate, 1));
        const price1w  = findClosestPrice(series, addDays(execDate, 7));
        const price1m  = findClosestPrice(series, addDays(execDate, 30));
        const price3m  = findClosestPrice(series, addDays(execDate, 90));

        // outcome_score: positive = decision was correct
        // BUY → good if price rose afterward
        // SELL → good if price fell afterward (exec_price was higher than future price)
        let outcomeScore: number | null = null;
        const refPrice = price1m ?? price1w ?? price1d;
        if (refPrice && execPrice > 0) {
          const pctChange = (refPrice - execPrice) / execPrice * 100;
          outcomeScore = action === "buy" ? pctChange : -pctChange;
        }

        // Pattern tags — simple rule-based
        const tags: string[] = [];
        if (outcomeScore !== null) {
          if (outcomeScore > 20) tags.push("strong_win");
          else if (outcomeScore > 5) tags.push("win");
          else if (outcomeScore < -20) tags.push("strong_loss");
          else if (outcomeScore < -5) tags.push("loss");
          else tags.push("breakeven");
        }
        tags.push(`regime:${regime.toLowerCase().replace(/ /g, "_")}`);

        await svc.from("trade_decisions").update({
          price_1d_after: price1d,
          price_1w_after: price1w,
          price_1m_after: price1m,
          price_3m_after: price3m,
          outcome_score: outcomeScore !== null ? parseFloat(outcomeScore.toFixed(2)) : null,
          pattern_tags: tags,
          macro_market_regime: regime,
          macro_event_tag: event_tag,
          price_data_available: true,
          enrichment_status: "enriched",
        }).eq("id", decision.id);

        results.enriched++;
      } catch {
        await svc.from("trade_decisions").update({ enrichment_status: "no_data" }).eq("id", decision.id);
        results.errors++;
      }
    }
  }

  return NextResponse.json({
    success: true,
    symbols_processed: symbols.length,
    ...results,
  });
}
