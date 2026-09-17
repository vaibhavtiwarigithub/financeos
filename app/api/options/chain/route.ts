import { NextRequest, NextResponse } from "next/server";
import { avCachedFetch } from "@/lib/av-cache";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get("symbol")?.toUpperCase();
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "ALPHA_VANTAGE_API_KEY not set" }, { status: 500 });

  try {
    // Fetch realtime options from Alpha Vantage
    const url = `https://www.alphavantage.co/query?function=REALTIME_OPTIONS&symbol=${symbol}&apikey=${apiKey}`;
    // Free-tier AV cannot sustain a per-view "realtime" options chain. A
    // same-day cached chain is honest about the data tier and cannot bypass the
    // provider's shared hard reservation.
    const raw = await avCachedFetch(`REALTIME_OPTIONS:${symbol}`, url, 10000);
    if (!raw) return NextResponse.json({ error: "provider_unavailable" }, { status: 503 });

    if (raw["Error Message"] || raw["Note"]) {
      return NextResponse.json({ error: raw["Error Message"] ?? raw["Note"] ?? "API limit" }, { status: 429 });
    }

    const options: any[] = raw.data ?? [];

    const calls = options
      .filter((o: any) => o.type === "call")
      .map((o: any) => ({
        strike: parseFloat(o.strike),
        bid: o.bid ? parseFloat(o.bid) : null,
        ask: o.ask ? parseFloat(o.ask) : null,
        implied_volatility: o.implied_volatility ? parseFloat(o.implied_volatility) : null,
        open_interest: o.open_interest ? parseInt(o.open_interest) : null,
        volume: o.volume ? parseInt(o.volume) : null,
        expiration: o.expiration,
      }))
      .sort((a: any, b: any) => a.strike - b.strike);

    const puts = options
      .filter((o: any) => o.type === "put")
      .map((o: any) => ({
        strike: parseFloat(o.strike),
        bid: o.bid ? parseFloat(o.bid) : null,
        ask: o.ask ? parseFloat(o.ask) : null,
        implied_volatility: o.implied_volatility ? parseFloat(o.implied_volatility) : null,
        open_interest: o.open_interest ? parseInt(o.open_interest) : null,
        volume: o.volume ? parseInt(o.volume) : null,
        expiration: o.expiration,
      }))
      .sort((a: any, b: any) => a.strike - b.strike);

    // Put/call ratio by open interest
    const totalCallOI = calls.reduce((s: number, o: any) => s + (o.open_interest ?? 0), 0);
    const totalPutOI = puts.reduce((s: number, o: any) => s + (o.open_interest ?? 0), 0);
    const put_call_ratio = totalCallOI > 0 ? totalPutOI / totalCallOI : null;

    // Avg IV across all options
    const ivValues = options
      .map((o: any) => o.implied_volatility ? parseFloat(o.implied_volatility) : null)
      .filter((v: any): v is number => v !== null);
    const avg_iv = ivValues.length > 0 ? ivValues.reduce((a, b) => a + b, 0) / ivValues.length : null;

    // Nearest expiry
    const expiries = options.map((o: any) => o.expiration).filter(Boolean).sort();
    const expiry = expiries[0] ?? null;

    return NextResponse.json({ calls, puts, put_call_ratio, avg_iv, expiry, total: options.length });
  } catch (e) {
    return NextResponse.json({ error: "Failed to fetch options" }, { status: 500 });
  }
}
