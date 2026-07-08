import { gunzipSync } from "zlib";
import { createServiceClient } from "@/lib/supabase/service";
import { providerCachedFetch } from "@/lib/data/provider-fetch";
import type { Candle } from "@/lib/data/technicals";

// Upstox India market-data adapter (read-only Analytics token, 1-yr, no daily
// refresh). Primary source for India candles/quotes/fundamentals, replacing the
// brittle unofficial Yahoo chart endpoint. Order execution is NOT here — that
// stays on Kite; this is data-only.
//
// Upstox keys instruments by `NSE_EQ|<ISIN>`, not by ticker, so we resolve
// tradingsymbol -> instrument_key via the official instrument master
// (assets.upstox.com/.../NSE.json.gz), cached in the upstox_instruments table
// (migration) and refreshed weekly. Serverless-friendly: the 85k-row master is
// parsed at most once per week, not per request.

const INSTRUMENTS_URL = "https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz";
const REFRESH_STALE_DAYS = 7;

function token(): string { return process.env.UPSTOX_ACCESS_TOKEN ?? ""; }
function bareSymbol(symbol: string): string { return symbol.toUpperCase().replace(/\.(NS|BO|NSE|BSE)$/i, ""); }

async function authHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${token()}`, Accept: "application/json" };
}

// Download + parse the NSE instrument master, filter to cash equities (EQ), and
// upsert tradingsymbol -> instrument_key. Heavy (2MB gz, 85k rows) — gated to at
// most once per REFRESH_STALE_DAYS by the caller.
async function refreshInstruments(svc: any): Promise<void> {
  const res = await fetch(INSTRUMENTS_URL, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`instrument master fetch ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const rows: any[] = JSON.parse(gunzipSync(buf).toString("utf8"));
  const eq = rows.filter((r) => r?.instrument_type === "EQ" && r?.segment === "NSE_EQ" && r?.trading_symbol && r?.instrument_key);
  const records = eq.map((r) => ({
    trading_symbol: String(r.trading_symbol).toUpperCase(),
    instrument_key: String(r.instrument_key),
    isin: r.isin ?? null,
    name: r.name ?? null,
    updated_at: new Date().toISOString(),
  }));
  // Upsert in chunks (a few thousand equities).
  for (let i = 0; i < records.length; i += 1000) {
    await svc.from("upstox_instruments").upsert(records.slice(i, i + 1000), { onConflict: "trading_symbol" });
  }
}

async function getInstrumentKey(svc: any, symbol: string): Promise<string | null> {
  const ts = bareSymbol(symbol);
  const { data } = await svc.from("upstox_instruments").select("instrument_key, updated_at").eq("trading_symbol", ts).maybeSingle();
  if (data?.instrument_key) return data.instrument_key;

  // Not found — refresh the master if we've never loaded it or it's stale, then retry once.
  const { data: newest } = await svc.from("upstox_instruments").select("updated_at").order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const stale = !newest || (Date.now() - new Date(newest.updated_at).getTime()) / 86400000 > REFRESH_STALE_DAYS;
  if (!stale) return null; // fresh table genuinely lacks this symbol
  try { await refreshInstruments(svc); } catch { return null; }
  const { data: retry } = await svc.from("upstox_instruments").select("instrument_key").eq("trading_symbol", ts).maybeSingle();
  return retry?.instrument_key ?? null;
}

// India daily candles via Upstox v3 historical-candle. Returns oldest-first
// (EMA/RSI need chronological), day-cached under the upstox provider budget.
export async function fetchUpstoxCandles(symbol: string, days = 160): Promise<Candle[]> {
  if (!token()) return [];
  try {
    const svc = createServiceClient();
    const key = await getInstrumentKey(svc, symbol);
    if (!key) return [];
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 2 * 86400000).toISOString().slice(0, 10);
    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(key)}/days/1/${to}/${from}`;
    const json = await providerCachedFetch("upstox", `UPSTOX_CANDLES:${bareSymbol(symbol)}`, url, {
      timeoutMs: 8000,
      headers: await authHeaders(),
      isThrottled: (j) => j?.status !== "success",
    });
    const rows: any[] = json?.data?.candles ?? [];
    return rows
      .map((c: any[]) => ({
        date: String(c[0]).slice(0, 10),
        open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] ?? 0,
      }))
      .filter((c: Candle) => Number.isFinite(c.close) && c.close > 0)
      .sort((a: Candle, b: Candle) => a.date.localeCompare(b.date)); // oldest first
  } catch { return []; }
}

// India LTP quote via Upstox market-quote.
export async function fetchUpstoxQuote(symbol: string): Promise<{ price: number; changePct: number } | null> {
  if (!token()) return null;
  try {
    const svc = createServiceClient();
    const key = await getInstrumentKey(svc, symbol);
    if (!key) return null;
    const url = `https://api.upstox.com/v2/market-quote/ltp?instrument_key=${encodeURIComponent(key)}`;
    const json = await providerCachedFetch("upstox", `UPSTOX_LTP:${bareSymbol(symbol)}`, url, {
      timeoutMs: 6000,
      headers: await authHeaders(),
      isThrottled: (j) => j?.status !== "success",
    });
    const first: any = json?.data ? Object.values(json.data)[0] : null;
    const price = first?.last_price;
    if (!price || price <= 0) return null;
    return { price, changePct: 0 }; // LTP endpoint doesn't carry prev close; change filled elsewhere
  } catch { return null; }
}
