// An earnings event invalidates a daily technical score until the candle series
// contains the event reaction. This is a data-freshness guard, not earnings
// alpha: it can only suppress a stale score/direction decision. Mechanical
// price exits remain outside this module.

export interface EarningsActualRow {
  report_date: string | null;
  actual_available_at: string | null;
  announcement_session: string | null;
  eps_actual_first: number | string | null;
}

export type EarningsRepricingState =
  | { pending: false; reason: "no_recent_event" | "event_not_occurred" | "post_event_daily_bar_available"; reportDate: string | null; actualAvailableAt: string | null }
  | { pending: true; reason: "post_event_daily_bar_missing"; reportDate: string; actualAvailableAt: string | null };

function isIsoDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function normalizedSession(value: unknown): "before_open" | "after_close" | "unknown" {
  const text = String(value ?? "").trim().toLowerCase();
  if (["bmo", "am", "before_open", "pre_market", "premarket"].includes(text)) return "before_open";
  if (["amc", "pm", "after_close", "post_market", "postmarket"].includes(text)) return "after_close";
  return "unknown";
}

function marketDay(now: Date, market: "us" | "india"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: market === "india" ? "Asia/Kolkata" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * A BMO result is reflected in the report-date daily bar. An AMC (or unknown
 * session) result needs the next daily bar. A known past event also activates
 * the barrier when the actual feed is late, closing the exact stale-score gap
 * that an `actual_available_at`-only test leaves open.
 */
export function evaluateEarningsRepricingBarrier(input: {
  latestDailyCandleDate: string | null | undefined;
  earnings: EarningsActualRow | null | undefined;
  market?: "us" | "india";
  now?: Date;
}): EarningsRepricingState {
  const reportDate = input.earnings?.report_date ?? null;
  const actualAvailableAt = input.earnings?.actual_available_at ?? null;
  if (!isIsoDay(reportDate)) {
    return { pending: false, reason: "no_recent_event", reportDate: null, actualAvailableAt: null };
  }
  const hasActual = Boolean(actualAvailableAt && Number.isFinite(Date.parse(actualAvailableAt)));
  const today = marketDay(input.now ?? new Date(), input.market ?? "us");
  const session = normalizedSession(input.earnings?.announcement_session);
  const eventOccurred = hasActual || reportDate < today || (reportDate === today && session === "before_open");
  if (!eventOccurred) {
    return { pending: false, reason: "event_not_occurred", reportDate, actualAvailableAt: hasActual ? actualAvailableAt : null };
  }
  const latest = isIsoDay(input.latestDailyCandleDate) ? input.latestDailyCandleDate : null;
  const barContainsReaction = latest != null && (
    session === "before_open" ? latest >= reportDate : latest > reportDate
  );
  if (!barContainsReaction) {
    return { pending: true, reason: "post_event_daily_bar_missing", reportDate, actualAvailableAt };
  }
  return { pending: false, reason: "post_event_daily_bar_available", reportDate, actualAvailableAt };
}

/** Read only existing PIT calendar state. No provider request is allowed here. */
export async function resolveEarningsRepricingBarrier(
  supabase: any,
  input: { symbol: string; market: "us" | "india"; latestDailyCandleDate: string | null | undefined },
): Promise<EarningsRepricingState> {
  const now = new Date();
  const today = marketDay(now, input.market);
  const cutoffDay = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from("earnings_calendar")
      .select("report_date,actual_available_at,announcement_session,eps_actual_first")
      .eq("symbol", input.symbol)
      .eq("market", input.market)
      .gte("report_date", cutoffDay)
      .lte("report_date", today)
      .order("report_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { pending: false, reason: "no_recent_event", reportDate: null, actualAvailableAt: null };
    return evaluateEarningsRepricingBarrier({
      latestDailyCandleDate: input.latestDailyCandleDate,
      earnings: data,
      market: input.market,
      now,
    });
  } catch {
    // The guard must never fabricate an earnings event from a failed read.
    return { pending: false, reason: "no_recent_event", reportDate: null, actualAvailableAt: null };
  }
}
