import { NextResponse } from "next/server";

const CRON_SECRET = process.env.CRON_SECRET;

/**
 * POST /api/calendar/earnings/refresh
 *
 * Cron refresh endpoint — invalidates the Supabase cache for all default
 * watchlist symbols so the next GET re-fetches from Massive API.
 *
 * Authenticate with: Authorization: Bearer <CRON_SECRET>
 * or:                x-cron-secret: <CRON_SECRET>
 */
export async function POST(req: Request) {
  // Auth check
  const authHeader = req.headers.get("authorization") ?? "";
  const cronHeader = req.headers.get("x-cron-secret") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : cronHeader;

  if (!CRON_SECRET || token !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Bust Supabase cache by clearing fetched_at — next GET will re-fetch from Massive
    const { createServiceClient } = await import("@/lib/supabase/service");
    const supabase = createServiceClient();

    const DEFAULT_WATCHLIST = [
      "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "PLTR", "SPY", "QQQ",
    ];

    const { error } = await supabase
      .from("earnings_calendar")
      .update({ fetched_at: "1970-01-01T00:00:00.000Z" })
      .in("symbol", DEFAULT_WATCHLIST);

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // Trigger a fresh fetch by calling the GET route internally
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const refreshRes = await fetch(
      `${baseUrl}/api/calendar/earnings`,
      { method: "GET" }
    );

    // Point-in-time earnings capture (features/known-anomalies §3): after the
    // GET has (re)fetched estimates, fill first-reported actuals for reports whose
    // date has passed and append pre-announcement consensus vintages for upcoming
    // ones. DATA CAPTURE ONLY — nothing on the money path reads this. Fail-soft:
    // a capture error must not fail the refresh (the cache bust already succeeded).
    let pit: unknown = null;
    try {
      const { captureEarningsPit } = await import("@/lib/data/earnings-pit");
      pit = await captureEarningsPit(DEFAULT_WATCHLIST, "us");
    } catch (e) {
      pit = { error: e instanceof Error ? e.message : String(e) };
    }

    if (!refreshRes.ok) {
      return NextResponse.json(
        { refreshed: false, note: "Cache busted but prefetch failed", status: refreshRes.status, pit },
        { status: 207 }
      );
    }

    return NextResponse.json({ refreshed: true, symbols: DEFAULT_WATCHLIST, pit });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
