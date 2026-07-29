import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchIndiaEarningsDate } from "@/lib/india-data";

// Event-proximity feature: days until a symbol's next earnings report. Captured
// into the decision_observations ledger so the LearnerAgent can test the "buy
// the rumor, sell the news" pattern — does high pre-earnings sentiment/hype fade
// after the print? — against real forward returns. Purely a logged feature; it
// does NOT gate or size a trade on its own.
//
// US: Finnhub earnings calendar (free, verified). India: Yahoo calendarEvents.

function marketTodayUtc(india: boolean): number {
  return marketDayUtc(new Date(), india);
}

function marketDayUtc(date: Date, india: boolean): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: india ? "Asia/Kolkata" : "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"));
}

export function daysFromToday(value: unknown, india = false): number | null {
  let time: number;
  let isMarketLocalDate = false;
  if (typeof value === "number" && Number.isFinite(value)) {
    time = value < 100_000_000_000 ? value * 1000 : value;
  } else if (typeof value === "string") {
    const date = value.trim();
    const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const usDay = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
    if (isoDay) {
      time = Date.UTC(Number(isoDay[1]), Number(isoDay[2]) - 1, Number(isoDay[3]));
      isMarketLocalDate = true;
    } else if (usDay) {
      time = Date.UTC(Number(usDay[3]), Number(usDay[1]) - 1, Number(usDay[2]));
      isMarketLocalDate = true;
    }
    else time = Date.parse(date);
  } else return null;
  if (!Number.isFinite(time)) return null;
  // An earnings event is a market-session date, not a UTC-duration countdown.
  // Normalize timestamps into the book's local market day before subtracting.
  const eventDay = isMarketLocalDate ? time : marketDayUtc(new Date(time), india);
  return Math.round((eventDay - marketTodayUtc(india)) / 86400000);
}

export type EarningsDateObservation = {
  date: string;
  session: "bmo" | "amc" | "during_session" | "unknown";
  source: "finnhub" | "yahoo_india";
  observedAt: string;
  confirmed: boolean;
};

export async function fetchEarningsDateObservation(
  symbol: string,
  market: "us" | "india",
): Promise<EarningsDateObservation | null> {
  const observedAt = new Date().toISOString();
  try {
    if (market === "india") {
      const date = await fetchIndiaEarningsDate(symbol).catch(() => null);
      return date ? {
        date: String(date).slice(0, 10),
        session: "unknown",
        source: "yahoo_india",
        observedAt,
        confirmed: false,
      } : null;
    }
    const key = process.env.FINNHUB_API_KEY ?? "";
    if (!key) return null;
    const today = new Date();
    const to = new Date(today.getTime() + 120 * 86400000);
    const fmt = (x: Date) => x.toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(today)}&to=${fmt(to)}&token=${key}`;
    const json = await providerCachedFetch("finnhub", `FINNHUB_EARN:${symbol}`, url, {
      timeoutMs: 6000,
      maxAgeDays: 1,
      isThrottled: (j) => !j?.earningsCalendar,
    });
    const rows: any[] = json?.earningsCalendar ?? [];
    const next = rows
      .filter((row) => typeof row?.date === "string")
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
    if (!next) return null;
    const hour = String(next.hour ?? "").toLowerCase();
    return {
      date: String(next.date).slice(0, 10),
      session: hour === "bmo" ? "bmo" : hour === "amc" ? "amc" : hour === "dmh" ? "during_session" : "unknown",
      source: "finnhub",
      observedAt,
      confirmed: false,
    };
  } catch {
    return null;
  }
}

export async function fetchDaysToEarnings(symbol: string, india: boolean, preferredDate?: string | number): Promise<number | null> {
  try {
    if (!india && preferredDate != null) return daysFromToday(preferredDate, false);
    if (india) {
      const dt = await fetchIndiaEarningsDate(symbol).catch(() => null);
      return dt ? daysFromToday(dt, true) : null;
    }
    const key = process.env.FINNHUB_API_KEY ?? "";
    if (!key) return null;
    const today = new Date();
    const to = new Date(today.getTime() + 120 * 86400000);
    const fmt = (x: Date) => x.toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(today)}&to=${fmt(to)}&token=${key}`;
    const json = await providerCachedFetch("finnhub", `FINNHUB_EARN:${symbol}`, url, {
      timeoutMs: 6000,
      isThrottled: (j) => !j?.earningsCalendar,
    });
    const rows: any[] = json?.earningsCalendar ?? [];
    const next = rows.map((r) => r.date).filter(Boolean).sort()[0];
    return next ? daysFromToday(next, false) : null;
  } catch { return null; }
}
