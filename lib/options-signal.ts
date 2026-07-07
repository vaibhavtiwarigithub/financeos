export interface OptionsSignal {
  symbol: string;
  putCallRatio: number;       // total put vol / total call vol (near-term)
  pcrSentiment: "Bullish" | "Bearish" | "Neutral";
  unusualCalls: UnusualContract[];  // high-volume OTM calls (smart money bullish bets)
  unusualPuts: UnusualContract[];   // high-volume OTM puts (hedging / bearish bets)
  ivPercentile: number | null;      // rough percentile vs 52-week range (null if not enough data)
  nearestExpiry: string;
  totalCallVolume: number;
  totalPutVolume: number;
  summary: string;            // plain English for LLM prompt injection
}

export interface UnusualContract {
  strike: number;
  expiry: string;
  type: "call" | "put";
  volume: number;
  openInterest: number;
  volOiRatio: number;
  impliedVolatility: number;
  lastPrice: number;
  inTheMoney: boolean;
}

export async function fetchOptionsSignal(symbol: string): Promise<OptionsSignal | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/options/${symbol.toUpperCase()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const result = data?.optionChain?.result?.[0];
    if (!result) return null;

    const quote = result.quote;
    const currentPrice: number = quote?.regularMarketPrice ?? 0;
    const expirations: number[] = result.expirationDates ?? [];
    const options = result.options?.[0]; // nearest expiry
    if (!options) return null;

    const nearestExpiry = expirations[0]
      ? new Date(expirations[0] * 1000).toISOString().slice(0, 10)
      : "unknown";

    const calls: any[] = options.calls ?? [];
    const puts: any[] = options.puts ?? [];

    // Totals
    const totalCallVolume = calls.reduce((s, c) => s + (c.volume ?? 0), 0);
    const totalPutVolume = puts.reduce((s, p) => s + (p.volume ?? 0), 0);
    const putCallRatio = totalCallVolume > 0 ? totalPutVolume / totalCallVolume : 1;

    // PCR sentiment
    let pcrSentiment: "Bullish" | "Bearish" | "Neutral" = "Neutral";
    if (putCallRatio < 0.7) pcrSentiment = "Bullish";
    else if (putCallRatio > 1.2) pcrSentiment = "Bearish";

    // Unusual activity: vol/OI > 3 AND significant volume (>100 contracts)
    const UNUSUAL_VOL_OI_RATIO = 3;
    const MIN_VOLUME = 100;

    function toUnusual(c: any, type: "call" | "put", inTheMoney: boolean): UnusualContract | null {
      const vol = c.volume ?? 0;
      const oi = c.openInterest ?? 1;
      const ratio = vol / oi;
      if (ratio < UNUSUAL_VOL_OI_RATIO || vol < MIN_VOLUME) return null;
      return {
        strike: c.strike ?? 0,
        expiry: c.expiration ? new Date(c.expiration * 1000).toISOString().slice(0, 10) : nearestExpiry,
        type,
        volume: vol,
        openInterest: oi,
        volOiRatio: Math.round(ratio * 10) / 10,
        impliedVolatility: Math.round((c.impliedVolatility ?? 0) * 100),
        lastPrice: c.lastPrice ?? 0,
        inTheMoney,
      };
    }

    const unusualCalls: UnusualContract[] = calls
      .map(c => toUnusual(c, "call", c.strike < currentPrice))
      .filter((x): x is UnusualContract => x !== null)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3);

    const unusualPuts: UnusualContract[] = puts
      .map(p => toUnusual(p, "put", p.strike > currentPrice))
      .filter((x): x is UnusualContract => x !== null)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3);

    // Rough IV percentile: compare ATM IV to min/max across all expirations
    const allIVs = [...calls, ...puts]
      .map(c => c.impliedVolatility ?? 0)
      .filter(iv => iv > 0);
    let ivPercentile: number | null = null;
    if (allIVs.length > 5 && calls.length > 0) {
      // A rigid 5% window can miss every strike on a wide-spaced chain (e.g.
      // underlyings >$500) even though a usable ATM proxy exists — fall back
      // to the nearest available strike instead of reporting unavailable.
      const withinWindow = calls.find(c => Math.abs(c.strike - currentPrice) < currentPrice * 0.05);
      const atm = withinWindow ?? calls.reduce((closest, c) =>
        Math.abs(c.strike - currentPrice) < Math.abs(closest.strike - currentPrice) ? c : closest
      );
      const atmIV = atm?.impliedVolatility ?? 0;
      const minIV = Math.min(...allIVs);
      const maxIV = Math.max(...allIVs);
      if (maxIV > minIV && atmIV > 0) {
        ivPercentile = Math.round(((atmIV - minIV) / (maxIV - minIV)) * 100);
      }
    }

    // Plain-English summary for LLM prompt
    const pcrLine = `Put/Call Ratio: ${putCallRatio.toFixed(2)} (${pcrSentiment} — ${totalCallVolume.toLocaleString()} calls vs ${totalPutVolume.toLocaleString()} puts)`;
    const ivLine = ivPercentile !== null ? `IV Percentile: ~${ivPercentile}% (${ivPercentile > 70 ? "high — options expensive" : ivPercentile < 30 ? "low — calm expected" : "moderate"})` : "";
    const unusualCallLine = unusualCalls.length
      ? `Unusual calls: ${unusualCalls.map(c => `$${c.strike} ${c.expiry} (${c.volume.toLocaleString()} vol, ${c.volOiRatio}× OI, IV ${c.impliedVolatility}%)`).join("; ")}`
      : "";
    const unusualPutLine = unusualPuts.length
      ? `Unusual puts: ${unusualPuts.map(p => `$${p.strike} ${p.expiry} (${p.volume.toLocaleString()} vol, ${p.volOiRatio}× OI, IV ${p.impliedVolatility}%)`).join("; ")}`
      : "";

    const summary = [pcrLine, ivLine, unusualCallLine, unusualPutLine]
      .filter(Boolean)
      .join("\n");

    return {
      symbol: symbol.toUpperCase(),
      putCallRatio: Math.round(putCallRatio * 100) / 100,
      pcrSentiment,
      unusualCalls,
      unusualPuts,
      ivPercentile,
      nearestExpiry,
      totalCallVolume,
      totalPutVolume,
      summary,
    };
  } catch {
    return null;
  }
}
