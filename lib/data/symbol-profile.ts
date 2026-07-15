// Stock Context — one symbol's profile (features/stock-context).
//
// DISPLAY-ONLY. This module is OFF THE MONEY PATH: nothing in scoring / sizing /
// gating / order code may import it. It only READS free providers and the
// symbol_profiles cache, and WRITES the cache via the service_role client.
//
// Deterministic: NO LLM is called here. The one-liner is composed from
// sector/industry/name; the market-cap tier is a threshold map.
//
// Providers (FREE only):
//   US    → Finnhub /stock/profile2 (name, industry, exchange, marketCap),
//           /stock/peers (peers), /calendar/earnings (next earnings date).
//   India → Yahoo (reused lib/india-data helpers) for name/sector/industry/
//           market-cap/exchange, fetchIndiaEarningsDate for earnings. Peers are
//           not available for free on India → stored empty (best-effort).

import { providerCachedFetch } from "@/lib/data/provider-fetch";
import { fetchIndiaOverview, fetchIndiaEarningsDate, isIndia } from "@/lib/india-data";

export type ProfileMarket = "us" | "india";
export type MarketCapTier = "mega" | "large" | "mid" | "small" | "micro";

export interface SymbolProfile {
  symbol: string;
  market: ProfileMarket;
  company_name: string | null;
  one_liner: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
  market_cap_tier: MarketCapTier | null;
  next_earnings_date: string | null; // YYYY-MM-DD
  peers: string[] | null;
  source: string | null;
  updated_at: string | null;
}

// A profile is considered fresh (skip re-fetch) if younger than this.
export const PROFILE_TTL_DAYS = 30;

// Map a market cap in USD MILLIONS to a coarse size tier. Finnhub's
// profile2.marketCapitalization is already in $millions. Yahoo's price.marketCap
// is in raw currency units; symbolProfileFromIndia converts to $millions first.
// India caps are in INR; we compare on a USD-equivalent (~83 INR/USD) so the
// tier label means the same size on both markets. Thresholds are the standard
// mega/large/mid/small/micro bands.
export function capTierFromUsdMillions(capUsdMillions: number | null | undefined): MarketCapTier | null {
  if (capUsdMillions == null || !Number.isFinite(capUsdMillions) || capUsdMillions <= 0) return null;
  if (capUsdMillions >= 200_000) return "mega";   // >= $200B
  if (capUsdMillions >= 10_000) return "large";   // >= $10B
  if (capUsdMillions >= 2_000) return "mid";      // >= $2B
  if (capUsdMillions >= 300) return "small";      // >= $300M
  return "micro";
}

// Rough INR→USD for tier bucketing only (never a money-path value). India
// market caps arrive in INR; convert so a tier label is comparable across markets.
const INR_PER_USD = 83;

// Deterministic one-sentence "what it does". No LLM. Prefers
// "<Name> — <industry> (<sector>), <exchange>" and degrades gracefully as fields
// are missing. Returns null when there's nothing meaningful to say.
export function composeOneLiner(input: {
  company_name: string | null;
  sector: string | null;
  industry: string | null;
  exchange: string | null;
}): string | null {
  const name = input.company_name?.trim() || null;
  const sector = input.sector?.trim() || null;
  const industry = input.industry?.trim() || null;
  const exchange = input.exchange?.trim() || null;

  // Build the "<industry> (<sector>)" descriptor, collapsing duplicates.
  let descriptor: string | null = null;
  if (industry && sector && industry.toLowerCase() !== sector.toLowerCase()) {
    descriptor = `${industry} (${sector})`;
  } else {
    descriptor = industry || sector;
  }

  const head = name ?? null;
  if (!head && !descriptor) return null;

  const parts: string[] = [];
  if (head && descriptor) parts.push(`${head} — ${descriptor}`);
  else parts.push(head ?? (descriptor as string));
  if (exchange) parts.push(exchange);
  return parts.join(", ");
}

// ── US via Finnhub ────────────────────────────────────────────────────────────
async function fetchUsProfile(symbol: string): Promise<Omit<SymbolProfile, "updated_at">> {
  const key = process.env.FINNHUB_API_KEY ?? "";
  const base: Omit<SymbolProfile, "updated_at"> = {
    symbol, market: "us", company_name: null, one_liner: null, sector: null,
    industry: null, exchange: null, market_cap_tier: null, next_earnings_date: null,
    peers: null, source: key ? "finnhub" : "unavailable",
  };
  if (!key) return base;

  // profile2 — name, industry, exchange, marketCapitalization ($millions).
  try {
    const profile = await providerCachedFetch(
      "finnhub", `FINNHUB_PROFILE:${symbol}`,
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { timeoutMs: 8000, maxAgeDays: PROFILE_TTL_DAYS },
    );
    if (profile && typeof profile === "object") {
      if (profile.name) base.company_name = String(profile.name);
      if (profile.finnhubIndustry) base.sector = String(profile.finnhubIndustry);
      if (profile.exchange) base.exchange = String(profile.exchange);
      base.market_cap_tier = capTierFromUsdMillions(
        typeof profile.marketCapitalization === "number" ? profile.marketCapitalization : null,
      );
    }
  } catch { /* fail-soft */ }

  // peers — up to a handful; context only.
  try {
    const peers = await providerCachedFetch(
      "finnhub", `FINNHUB_PEERS:${symbol}`,
      `https://finnhub.io/api/v1/stock/peers?symbol=${encodeURIComponent(symbol)}&token=${key}`,
      { timeoutMs: 8000, maxAgeDays: PROFILE_TTL_DAYS, isThrottled: (j) => !Array.isArray(j) },
    );
    if (Array.isArray(peers)) {
      // Finnhub returns the symbol itself first — drop it, cap the list.
      const cleaned = peers
        .filter((p): p is string => typeof p === "string" && p.length > 0 && p.toUpperCase() !== symbol.toUpperCase());
      base.peers = [...new Set(cleaned)].slice(0, 6);
    }
  } catch { /* fail-soft */ }

  // next earnings date — Finnhub calendar/earnings, nearest upcoming.
  try {
    const today = new Date();
    const to = new Date(today.getTime() + 120 * 86400000);
    const fmt = (x: Date) => x.toISOString().slice(0, 10);
    const cal = await providerCachedFetch(
      "finnhub", `FINNHUB_EARN:${symbol}`,
      `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(today)}&to=${fmt(to)}&token=${key}`,
      { timeoutMs: 6000, isThrottled: (j) => !j?.earningsCalendar },
    );
    const rows: any[] = cal?.earningsCalendar ?? [];
    const next = rows.map((r) => r?.date).filter(Boolean).map((d) => String(d).slice(0, 10)).sort()[0];
    if (next) base.next_earnings_date = next;
  } catch { /* fail-soft */ }

  base.one_liner = composeOneLiner(base);
  return base;
}

// ── India via Yahoo ───────────────────────────────────────────────────────────
async function fetchIndiaProfile(symbol: string): Promise<Omit<SymbolProfile, "updated_at">> {
  const base: Omit<SymbolProfile, "updated_at"> = {
    symbol, market: "india", company_name: null, one_liner: null, sector: null,
    industry: null, exchange: null, market_cap_tier: null, next_earnings_date: null,
    peers: null, source: "yahoo",
  };

  try {
    const ov = await fetchIndiaOverview(symbol); // { Name?, Sector?, Industry?, Exchange?, MarketCapitalization? (INR) }
    if (ov.Name) base.company_name = String(ov.Name);
    if (ov.Sector) base.sector = String(ov.Sector);
    if (ov.Industry) base.industry = String(ov.Industry);
    base.exchange = ov.Exchange ? String(ov.Exchange) : (symbol.toUpperCase().endsWith(".BO") ? "BSE" : "NSE");
    const capInr = ov.MarketCapitalization ? Number(ov.MarketCapitalization) : NaN;
    if (Number.isFinite(capInr) && capInr > 0) {
      base.market_cap_tier = capTierFromUsdMillions(capInr / INR_PER_USD / 1_000_000);
    }
  } catch { /* fail-soft */ }

  // Earnings — best-effort (Yahoo calendarEvents). Peers unavailable for free on India.
  try {
    const dt = await fetchIndiaEarningsDate(symbol);
    if (dt) base.next_earnings_date = String(dt).slice(0, 10);
  } catch { /* fail-soft */ }
  base.peers = []; // explicit: no free India peers source (best-effort, acceptable)

  base.one_liner = composeOneLiner(base);
  return base;
}

// Compose a fresh profile from providers (no cache read/write). Exported for the
// backfill route, which persists the result.
export async function fetchSymbolProfile(symbol: string, market?: ProfileMarket): Promise<Omit<SymbolProfile, "updated_at">> {
  const sym = symbol.toUpperCase();
  const mkt: ProfileMarket = market ?? (isIndia(sym) ? "india" : "us");
  return mkt === "india" ? fetchIndiaProfile(sym) : fetchUsProfile(sym);
}

// Read-through cache: return the cached row if fresh (<PROFILE_TTL_DAYS), else
// fetch, upsert, and return. `svc` is a service_role client (bypasses RLS).
export async function getSymbolProfile(
  symbol: string,
  market: ProfileMarket | undefined,
  svc: { from: (t: string) => any },
): Promise<SymbolProfile | null> {
  const sym = symbol.toUpperCase();
  const mkt: ProfileMarket = market ?? (isIndia(sym) ? "india" : "us");

  const { data: cached } = await svc
    .from("symbol_profiles")
    .select("*")
    .eq("symbol", sym)
    .eq("market", mkt)
    .maybeSingle();

  if (cached?.updated_at) {
    const ageDays = (Date.now() - new Date(cached.updated_at).getTime()) / 86400000;
    if (ageDays <= PROFILE_TTL_DAYS) return cached as SymbolProfile;
  }

  const fresh = await fetchSymbolProfile(sym, mkt);
  const row = { ...fresh, updated_at: new Date().toISOString() };
  try {
    await svc.from("symbol_profiles").upsert(row, { onConflict: "symbol,market" });
  } catch { /* write is best-effort; still return the fetched profile */ }
  return row as SymbolProfile;
}
