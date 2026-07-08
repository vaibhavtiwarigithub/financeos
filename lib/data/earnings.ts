import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchIndiaEarningsDate } from "@/lib/india-data";

// Event-proximity feature: days until a symbol's next earnings report. Captured
// into the decision_observations ledger so the LearnerAgent can test the "buy
// the rumor, sell the news" pattern — does high pre-earnings sentiment/hype fade
// after the print? — against real forward returns. Purely a logged feature; it
// does NOT gate or size a trade on its own.
//
// US: Finnhub earnings calendar (free, verified). India: Yahoo calendarEvents.

function daysFromToday(isoDate: string): number | null {
  const d = new Date(isoDate + "T00:00:00Z").getTime();
  if (!Number.isFinite(d)) return null;
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Math.round((d - today) / 86400000);
}

export async function fetchDaysToEarnings(symbol: string, india: boolean): Promise<number | null> {
  try {
    if (india) {
      const dt = await fetchIndiaEarningsDate(symbol).catch(() => null);
      return dt ? daysFromToday(String(dt).slice(0, 10)) : null;
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
    return next ? daysFromToday(String(next).slice(0, 10)) : null;
  } catch { return null; }
}
