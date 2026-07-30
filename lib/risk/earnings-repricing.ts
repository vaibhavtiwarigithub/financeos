// A reported earnings result invalidates a daily technical score until the
// candle series contains at least one post-report session. This is a data
// freshness guard, not an earnings-alpha signal: it can only suppress a stale
// score/direction decision. Mechanical price exits remain outside this module.

export interface EarningsActualRow {
  report_date: string | null;
  actual_available_at: string | null;
  announcement_session: string | null;
  eps_actual_first: number | string | null;
}

export type EarningsRepricingState =
  | { pending: false; reason: "no_recent_actual" | "post_event_daily_bar_available"; reportDate: string | null; actualAvailableAt: string | null }
  | { pending: true; reason: "post_event_daily_bar_missing"; reportDate: string; actualAvailableAt: string };

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

/**
 * Daily technicals cannot see an AMC result in that same day's closing candle.
 * The first candle strictly after the report date is the earliest complete daily
 * bar that can contain the market's reaction, regardless of BMO/AMC timing.
 */
export function evaluateEarningsRepricingBarrier(input: {
  latestDailyCandleDate: string | null | undefined;
  earnings: EarningsActualRow | null | undefined;
}): EarningsRepricingState {
  const reportDate = input.earnings?.report_date ?? null;
  const actualAvailableAt = input.earnings?.actual_available_at ?? null;
  if (!isIsoDay(reportDate) || !actualAvailableAt || !Number.isFinite(Date.parse(actualAvailableAt))) {
    return { pending: false, reason: "no_recent_actual", reportDate: null, actualAvailableAt: null };
  }
  if (!isIsoDay(input.latestDailyCandleDate) || input.latestDailyCandleDate <= reportDate) {
    return { pending: true, reason: "post_event_daily_bar_missing", reportDate, actualAvailableAt };
  }
  return { pending: false, reason: "post_event_daily_bar_available", reportDate, actualAvailableAt };
}

/** Read only existing PIT calendar state. No provider request is allowed here. */
export async function resolveEarningsRepricingBarrier(
  supabase: any,
  input: { symbol: string; market: "us" | "india"; latestDailyCandleDate: string | null | undefined },
): Promise<EarningsRepricingState> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("earnings_calendar")
      .select("report_date,actual_available_at,announcement_session,eps_actual_first")
      .eq("symbol", input.symbol)
      .eq("market", input.market)
      .not("actual_available_at", "is", null)
      .gte("actual_available_at", cutoff)
      .order("actual_available_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { pending: false, reason: "no_recent_actual", reportDate: null, actualAvailableAt: null };
    return evaluateEarningsRepricingBarrier({ latestDailyCandleDate: input.latestDailyCandleDate, earnings: data });
  } catch {
    // The guard must never fabricate an earnings event from a failed read.
    return { pending: false, reason: "no_recent_actual", reportDate: null, actualAvailableAt: null };
  }
}
