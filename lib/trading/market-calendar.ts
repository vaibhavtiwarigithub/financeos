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
const US_HOLIDAYS = new Set<string>([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);
const INDIA_HOLIDAYS = new Set<string>([
  "2026-01-26", "2026-03-06", "2026-03-25", "2026-04-03", "2026-04-14",
  "2026-05-01", "2026-08-15", "2026-10-02", "2026-11-09", "2026-12-25",
]);

export function isMarketHoliday(market: string, localYmd: string): boolean {
  return (market === "india" ? INDIA_HOLIDAYS : US_HOLIDAYS).has(localYmd);
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
