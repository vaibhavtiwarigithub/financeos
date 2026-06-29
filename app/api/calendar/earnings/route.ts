import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

// Hardcoded watchlist — also accepts ?symbols=AAPL,MSFT override
const DEFAULT_WATCHLIST = [
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA",
  "AMD", "PLTR", "JPM", "V", "UNH", "NFLX", "CRM", "ADBE",
];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export type EarningsEvent = {
  symbol: string;
  name: string;
  reportDate: string;
  timing: "am" | "pm" | "";
  epsEstimate: string;
  epsActual: string | null;
  quarter: string;
};

// Alpha Vantage EARNINGS_CALENDAR returns CSV:
// symbol,name,reportDate,fiscalDateEnding,estimate,currency
async function fetchFromAlphaVantage(symbols: string[]): Promise<EarningsEvent[]> {
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  if (!key) return [];

  // horizon=3month covers next 90 days of earnings
  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=${key}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const csv = await res.text();
    const lines = csv.trim().split("\n");
    if (lines.length < 2) return [];

    // Parse CSV: symbol,name,reportDate,fiscalDateEnding,estimate,currency
    const symbolSet = new Set(symbols.map(s => s.toUpperCase()));
    const events: EarningsEvent[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(",");
      const sym = (cols[0] ?? "").trim().toUpperCase();
      if (!symbolSet.has(sym)) continue;
      const reportDate = (cols[2] ?? "").trim();
      if (!reportDate) continue;
      events.push({
        symbol: sym,
        name: (cols[1] ?? sym).trim(),
        reportDate,
        timing: "",
        epsEstimate: (cols[4] ?? "").trim(),
        epsActual: null,
        quarter: (cols[3] ?? "").trim(), // fiscalDateEnding used as quarter proxy
      });
    }
    return events;
  } catch {
    return [];
  }
}

function rowToEvent(row: Record<string, unknown>): EarningsEvent {
  return {
    symbol: String(row.symbol),
    name: String(row.symbol),
    reportDate: String(row.report_date),
    timing: (row.report_time === "am" || row.report_time === "pm"
      ? row.report_time : "") as "am" | "pm" | "",
    epsEstimate: row.eps_estimate != null ? String(row.eps_estimate) : "",
    epsActual: row.eps_actual != null ? String(row.eps_actual) : null,
    quarter: row.fiscal_quarter ? `Q${row.fiscal_quarter} ${row.fiscal_year ?? ""}` : "",
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolsParam = url.searchParams.get("symbols");
  const symbols = symbolsParam
    ? symbolsParam.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_WATCHLIST;

  const svc = createServiceClient();
  const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();

  // Cache check
  const { data: cached } = await svc
    .from("earnings_calendar")
    .select("*")
    .in("symbol", symbols)
    .gte("fetched_at", cutoff);

  const cachedSet = new Set<string>((cached ?? []).map((r: Record<string, unknown>) => String(r.symbol)));
  const stale = symbols.filter(s => !cachedSet.has(s));

  if (stale.length === 0 && (cached?.length ?? 0) > 0) {
    const events = (cached as Record<string, unknown>[]).map(rowToEvent);
    events.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return NextResponse.json({ earnings: events, source: "cache" });
  }

  // Fetch from Alpha Vantage (one call covers all symbols)
  const fresh = await fetchFromAlphaVantage(stale.length > 0 ? symbols : stale);

  if (fresh.length > 0) {
    const rows = fresh.map(ev => ({
      symbol: ev.symbol,
      report_date: ev.reportDate,
      report_time: ev.timing || null,
      eps_estimate: ev.epsEstimate ? Number(ev.epsEstimate) : null,
      eps_actual: null,
      revenue_estimate: null,
      revenue_actual: null,
      fiscal_quarter: null,
      fiscal_year: null,
      fetched_at: new Date().toISOString(),
    }));
    await svc.from("earnings_calendar").upsert(rows, { onConflict: "symbol,report_date" });
  }

  // Merge with still-cached
  const all = [
    ...fresh,
    ...((cached ?? []) as Record<string, unknown>[]).map(rowToEvent).filter(e => !fresh.find(f => f.symbol === e.symbol)),
  ];

  if (all.length === 0) {
    // DB fallback — stale data better than nothing
    const { data: fb } = await svc.from("earnings_calendar").select("*").in("symbol", symbols);
    const fbEvents = ((fb ?? []) as Record<string, unknown>[]).map(rowToEvent);
    fbEvents.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
    return NextResponse.json({ earnings: fbEvents, source: "db_fallback" });
  }

  all.sort((a, b) => a.reportDate.localeCompare(b.reportDate));
  return NextResponse.json({ earnings: all, source: "live" });
}
