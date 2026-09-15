// GET /api/calendar/earnings/cached
//
// The stored US earnings calendar, safe for viewers. The parent
// `/api/calendar/earnings` refreshes from Alpha Vantage when its 24h cache is
// stale; this reads earnings_calendar and nothing else. It can therefore be as
// old as the last time the owner's calendar refreshed, and says so.
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireViewerOrOwner } from "@/lib/auth/session-role";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { gate } = await requireViewerOrOwner(req);
  if (gate) return gate;

  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await createServiceClient()
    .from("earnings_calendar")
    .select("symbol, report_date, report_time, eps_estimate, eps_actual, fiscal_quarter, fiscal_year, fetched_at")
    .gte("report_date", since)
    .order("report_date", { ascending: true })
    .limit(300);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = data ?? [];
  const earnings = rows.map((row: any) => ({
    symbol: String(row.symbol),
    name: String(row.symbol),
    reportDate: String(row.report_date),
    timing: row.report_time === "am" || row.report_time === "pm" ? row.report_time : "",
    epsEstimate: row.eps_estimate != null ? String(row.eps_estimate) : "",
    epsActual: row.eps_actual != null ? String(row.eps_actual) : null,
    quarter: row.fiscal_quarter ? `Q${row.fiscal_quarter} ${row.fiscal_year ?? ""}` : "",
  }));
  let lastRefreshed: string | null = null;
  for (const r of rows as Array<{ fetched_at: string | null }>) {
    const at = r.fetched_at ? String(r.fetched_at) : null;
    if (at && (!lastRefreshed || at > lastRefreshed)) lastRefreshed = at;
  }

  return NextResponse.json({
    earnings,
    source: "cache",
    note: lastRefreshed
      ? `Stored calendar, last refreshed ${lastRefreshed.slice(0, 10)}.`
      : "No stored earnings dates yet.",
  });
}
