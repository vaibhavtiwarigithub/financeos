// Market calendar + live status. Layered gate for whether an exchange is
// actually open for order placement:
//   1. isMarketSessionOpen  — cheap local: weekday + regular hours + holiday list.
//   2. isMarketOpenLive     — authoritative: confirms US via Alpha Vantage
//      MARKET_STATUS (catches UNSCHEDULED closures + needs no yearly calendar
//      update); India relies on the session guard + the sizing path's live-quote
//      freshness check (no clean Kite "is-open" API). Broker order rejection is
//      the ultimate backstop for any halt this layer misses.

// ── Static holiday calendars (defense/fallback layer) ────────────────────────
// A holiday on a weekday would otherwise pass weekday+hours. UPDATE ANNUALLY or
// rely on the live status source (US) / quote-freshness (India) above it.
// Explicit equity-market calendars. Catch-up refuses unsupported years so a
// stale calendar cannot silently treat an exchange holiday as a normal weekend.
// US: https://www.nyse.com/trade/hours-calendars
// India CM: https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf
// India amendment: https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf
// India special sessions: https://www.nseindia.com/resources/exchange-communication-holidays
const MARKET_HOLIDAYS: Record<"us" | "india", Record<string, ReadonlySet<string>>> = {
  us: {
    "2026": new Set([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
      "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]),
  },
  india: {
    "2026": new Set([
      "2026-01-15", // NSE/CMTR/72260 amendment: Maharashtra municipal election.
      "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
      "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14",
      "2026-10-02", "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
    ]),
  },
};

// A weekend can still contain an official special session. It is neither a full
// closure nor a regular session, so closed-day catch-up must abstain.
const MARKET_SPECIAL_SESSIONS: Record<"us" | "india", Record<string, ReadonlySet<string>>> = {
  us: { "2026": new Set() },
  india: { "2026": new Set(["2026-11-08"]) }, // Diwali Muhurat Trading.
};

type MarketDayKind = "trading_day" | "weekend" | "holiday" | "special_session" | "unsupported_year";

export type MarketDayStatus = {
  localYmd: string;
  kind: MarketDayKind;
  calendarSupported: boolean;
};

function marketKey(market: string): "us" | "india" {
  return market === "india" ? "india" : "us";
}

export function isMarketHoliday(market: string, localYmd: string): boolean {
  const year = localYmd.slice(0, 4);
  return MARKET_HOLIDAYS[marketKey(market)][year]?.has(localYmd) ?? false;
}

function marketDateParts(market: string, now: Date): { ymd: string; weekday: string } {
  const tz = market === "india" ? "Asia/Kolkata" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { ymd: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
}

export type LocalSlotDecision =
  | { admitted: true; localTime: string }
  | { admitted: false; localTime: string; reason: "invalid_slot" | "slot_mismatch" };

/**
 * Admit a paired seasonal UTC cron only at its declared exchange-local time.
 * The second UTC invocation exits before provider or database work.
 */
export function admitMarketLocalSlot(
  market: string,
  expected: string,
  now: Date = new Date(),
): LocalSlotDecision {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(expected)) {
    return { admitted: false, localTime: "invalid", reason: "invalid_slot" };
  }
  const tz = market === "india" ? "Asia/Kolkata" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const localTime = `${String(Number.parseInt(get("hour"), 10) % 24).padStart(2, "0")}:${get("minute")}`;
  return localTime === expected
    ? { admitted: true, localTime }
    : { admitted: false, localTime, reason: "slot_mismatch" };
}

export function isMarketWeekend(market: string, now: Date = new Date()): boolean {
  return ["Sat", "Sun"].includes(marketDateParts(market, now).weekday);
}

export function getMarketDayStatus(market: string, now: Date = new Date()): MarketDayStatus {
  const key = marketKey(market);
  const local = marketDateParts(key, now);
  const year = local.ymd.slice(0, 4);
  const holidays = MARKET_HOLIDAYS[key][year];
  const specialSessions = MARKET_SPECIAL_SESSIONS[key][year];
  if (!holidays || !specialSessions) {
    return { localYmd: local.ymd, kind: "unsupported_year", calendarSupported: false };
  }
  if (specialSessions.has(local.ymd)) {
    return { localYmd: local.ymd, kind: "special_session", calendarSupported: true };
  }
  if (["Sat", "Sun"].includes(local.weekday)) {
    return { localYmd: local.ymd, kind: "weekend", calendarSupported: true };
  }
  if (holidays.has(local.ymd)) {
    return { localYmd: local.ymd, kind: "holiday", calendarSupported: true };
  }
  return { localYmd: local.ymd, kind: "trading_day", calendarSupported: true };
}

export function getClosedDayCatchupEligibility(
  market: string,
  now: Date = new Date(),
): { eligible: boolean; reason: MarketDayKind; localYmd: string } {
  const status = getMarketDayStatus(market, now);
  return {
    eligible: status.kind === "weekend" || status.kind === "holiday",
    reason: status.kind,
    localYmd: status.localYmd,
  };
}

/** Last completed regular session, used to label non-executable closed-day research. */
export function lastCompletedMarketSession(market: string, now: Date = new Date()): string {
  const local = marketDateParts(market, now);
  const cursor = new Date(`${local.ymd}T12:00:00Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const ymd = cursor.toISOString().slice(0, 10);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6 && !isMarketHoliday(market, ymd)) return ymd;
  } while (true);
}

// ── Cheap local session check ────────────────────────────────────────────────
export function isMarketSessionOpen(market: string, now: Date = new Date()): boolean {
  const tz = market === "india" ? "Asia/Kolkata" : "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  if (["Sat", "Sun"].includes(get("weekday"))) return false;
  const localYmd = `${get("year")}-${get("month")}-${get("day")}`;
  if (isMarketHoliday(market, localYmd)) return false;
  const mins = (parseInt(get("hour") || "0", 10) % 24) * 60 + parseInt(get("minute") || "0", 10);
  const open = market === "india" ? 9 * 60 + 15 : 9 * 60 + 30;
  const close = market === "india" ? 15 * 60 + 30 : 16 * 60;
  return mins >= open && mins <= close;
}

// ── Authoritative status via Alpha Vantage MARKET_STATUS (short-cached) ───────
// AV returns a global list of equity markets by region incl. United States AND
// India — one call authoritatively covers both, catches UNSCHEDULED closures,
// and needs no yearly calendar update.
type MktStatus = "open" | "closed" | "unknown";
let _statusCache: { at: number; byMarket: Record<string, MktStatus> } | null = null;
const STATUS_TTL_MS = 5 * 60 * 1000;

const REGION_MATCH: Record<string, RegExp> = {
  us: /United States|NYSE|Nasdaq/i,
  india: /India|NSE|BSE/i,
};

async function fetchMarketStatuses(): Promise<Record<string, MktStatus>> {
  if (_statusCache && Date.now() - _statusCache.at < STATUS_TTL_MS) return _statusCache.byMarket;
  const key = process.env.ALPHA_VANTAGE_API_KEY;
  const byMarket: Record<string, MktStatus> = { us: "unknown", india: "unknown" };
  if (!key) return byMarket;
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=MARKET_STATUS&apikey=${key}`, { cache: "no-store" });
    if (!res.ok) return byMarket;
    const body = await res.json();
    const markets: any[] = Array.isArray(body?.markets) ? body.markets : [];
    for (const mkt of ["us", "india"] as const) {
      const row = markets.find((m) => String(m?.market_type ?? "").toLowerCase() === "equity" &&
        REGION_MATCH[mkt].test(String(m?.region ?? "") + " " + String(m?.primary_exchanges ?? "")));
      const cur = String(row?.current_status ?? "").toLowerCase();
      byMarket[mkt] = cur === "open" ? "open" : cur === "closed" ? "closed" : "unknown";
    }
    _statusCache = { at: Date.now(), byMarket };
    return byMarket;
  } catch {
    return byMarket;
  }
}

// Authoritative "is this market open for an order right now?" Fail-closed on a
// confirmed CLOSED (incl. unscheduled). When the live source is unreachable, fall
// back to the local session guard (already passed) — the broker rejection is the
// ultimate backstop for any missed halt.
export async function isMarketOpenLive(market: string, now: Date = new Date()): Promise<{ open: boolean; reason: string }> {
  if (!isMarketSessionOpen(market, now)) return { open: false, reason: "outside session / weekend / holiday" };
  const status = (await fetchMarketStatuses())[market] ?? "unknown";
  if (status === "open") return { open: true, reason: "AV MARKET_STATUS=open" };
  if (status === "closed") return { open: false, reason: "AV MARKET_STATUS=closed (possible unscheduled closure)" };
  return { open: true, reason: "session open; live status unavailable (broker-rejection + quote-freshness backstop)" };
}
