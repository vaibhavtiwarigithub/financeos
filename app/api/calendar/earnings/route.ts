import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

const DEFAULT_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "PLTR", "SPY", "QQQ",
];

const MASSIVE_API_KEY = process.env.MASSIVE_API_KEY;
// 24-hour cache window — earnings dates don't shift day-to-day
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type EarningsEvent = {
  symbol: string;
  name: string;
  reportDate: string;
  timing: "am" | "pm" | "";
  epsEstimate: string;
  epsActual: string | null;
  quarter: string;
};

interface MassiveEarningsResult {
  results?: Array<{
    date?: string;
    type?: string;
    name?: string;
    eps?: { estimate?: number | string; actual?: number | string };
    revenue?: { estimate?: number | string; actual?: number | string };
    fiscalQuarter?: number | string;
    fiscalYear?: number | string;
    afterHours?: boolean;
    timeOfDay?: string;
  }>;
  status?: string;
}

function dbRowToEvent(row: Record<string, unknown>): EarningsEvent {
  return {
    symbol: String(row.symbol),
    name: String(row.symbol),
    reportDate: String(row.report_date),
    timing: (row.report_time === "am" || row.report_time === "pm"
      ? row.report_time
      : "") as "am" | "pm" | "",
    epsEstimate: row.eps_estimate != null ? String(row.eps_estimate) : "",
    epsActual: row.eps_actual != null ? String(row.eps_actual) : null,
    quarter: row.fiscal_quarter
      ? `Q${row.fiscal_quarter} ${row.fiscal_year ?? ""}`
      : "",
  };
}

async function fetchFromMassive(symbol: string): Promise<EarningsEvent | null> {
  if (!MASSIVE_API_KEY) return null;

  // Try vX first (richer payload), fall back to v2
  const endpoints = [
    `https://api.massive.com/vX/reference/tickers/${symbol}/events?apiKey=${MASSIVE_API_KEY}`,
    `https://api.massive.com/v2/reference/tickers/${symbol}/events?types=earnings&apiKey=${MASSIVE_API_KEY}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data: MassiveEarningsResult = await res.json();
      const results = data.results ?? [];

      const earningsEvents = results.filter(
        (r) => r.type === "earnings" || r.name?.toLowerCase().includes("earnings")
      );
      if (earningsEvents.length === 0) continue;

      // Prefer next upcoming date; fallback to most recent past
      const today = new Date().toISOString().slice(0, 10);
      const future = earningsEvents.filter((r) => r.date && r.date >= today);
      const chosen =
        future.length > 0 ? future[0] : earningsEvents[earningsEvents.length - 1];
      if (!chosen?.date) continue;

      const afterHours =
        chosen.afterHours ?? chosen.timeOfDay === "after_close";
      const timing: "am" | "pm" | "" =
        afterHours === true ? "pm" : afterHours === false ? "am" : "";

      const epsEst = chosen.eps?.estimate;
      const epsAct = chosen.eps?.actual;

      return {
        symbol,
        name: symbol,
        reportDate: chosen.date,
        timing,
        epsEstimate: epsEst != null ? String(epsEst) : "",
        epsActual: epsAct != null ? String(epsAct) : null,
        quarter: chosen.fiscalQuarter
          ? `Q${chosen.fiscalQuarter} ${chosen.fiscalYear ?? ""}`
          : "",
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");
  const symbols = symbolsParam
    ? symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : DEFAULT_WATCHLIST;

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();

  // --- Check Supabase cache ---
  const { data: cached } = await supabase
    .from("earnings_calendar")
    .select("*")
    .in("symbol", symbols)
    .gte("fetched_at", cutoff);

  const cachedSymbols = new Set<string>(
    (cached ?? []).map((r: Record<string, unknown>) => String(r.symbol))
  );
  const staleSymbols = symbols.filter((s) => !cachedSymbols.has(s));

  // All symbols fresh in cache
  if (staleSymbols.length === 0 && (cached?.length ?? 0) > 0) {
    const earnings = (cached as Record<string, unknown>[]).map(dbRowToEvent);
    earnings.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return NextResponse.json({ earnings, source: "cache" });
  }

  // --- Fetch stale/missing symbols from Massive API in parallel ---
  const fetchResults = await Promise.allSettled(
    staleSymbols.map((sym) => fetchFromMassive(sym))
  );

  const newEvents: EarningsEvent[] = [];
  const upsertRows: Record<string, unknown>[] = [];

  for (const result of fetchResults) {
    if (result.status === "fulfilled" && result.value) {
      const ev = result.value;
      newEvents.push(ev);
      upsertRows.push({
        symbol: ev.symbol,
        report_date: ev.reportDate,
        report_time: ev.timing || null,
        eps_estimate: ev.epsEstimate ? Number(ev.epsEstimate) : null,
        eps_actual: ev.epsActual != null ? Number(ev.epsActual) : null,
        revenue_estimate: null,
        revenue_actual: null,
        fiscal_quarter: ev.quarter
          ? ev.quarter.split(" ")[0]?.replace("Q", "")
          : null,
        fiscal_year: ev.quarter ? ev.quarter.split(" ")[1] : null,
        fetched_at: new Date().toISOString(),
      });
    }
  }

  // Persist fresh data to Supabase
  if (upsertRows.length > 0) {
    await supabase
      .from("earnings_calendar")
      .upsert(upsertRows, { onConflict: "symbol" });
  }

  // If Massive returned nothing, fall back to anything in DB for those symbols
  if (newEvents.length === 0 && staleSymbols.length > 0) {
    const { data: fallbackData } = await supabase
      .from("earnings_calendar")
      .select("*")
      .in("symbol", symbols);

    const fallbackEvents = (
      (fallbackData ?? []) as Record<string, unknown>[]
    ).map(dbRowToEvent);
    fallbackEvents.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return NextResponse.json({ earnings: fallbackEvents, source: "db_fallback" });
  }

  // Merge new + still-cached, deduplicate (newer data wins)
  const allEvents: EarningsEvent[] = [
    ...newEvents,
    ...((cached ?? []) as Record<string, unknown>[]).map(dbRowToEvent),
  ];
  const seen = new Set<string>();
  const deduplicated = allEvents.filter((ev) => {
    if (seen.has(ev.symbol)) return false;
    seen.add(ev.symbol);
    return true;
  });
  deduplicated.sort((a, b) => a.reportDate.localeCompare(b.reportDate));

  return NextResponse.json({ earnings: deduplicated, source: "live" });
}
