// Static NIFTY-50 constituent list (NSE `.NS` tickers) — the free stand-in for
// a paid India screener. The research pipeline draws India candidates from here
// (plus the user's real Kite holdings) instead of a live screen. A static index
// list is fine for a ~10-symbol/run pipeline and costs nothing.
// Update this list if index composition changes materially.
export const NIFTY_50: string[] = [
  "RELIANCE.NS", "HDFCBANK.NS", "ICICIBANK.NS", "INFY.NS", "TCS.NS",
  "ITC.NS", "LT.NS", "AXISBANK.NS", "SBIN.NS", "BHARTIARTL.NS",
  "KOTAKBANK.NS", "HINDUNILVR.NS", "BAJFINANCE.NS", "ASIANPAINT.NS", "MARUTI.NS",
  "HCLTECH.NS", "SUNPHARMA.NS", "TITAN.NS", "ULTRACEMCO.NS", "WIPRO.NS",
  "NESTLEIND.NS", "TATAMOTORS.NS", "POWERGRID.NS", "NTPC.NS", "TATASTEEL.NS",
  "M&M.NS", "TECHM.NS", "ADANIENT.NS", "JSWSTEEL.NS", "HDFCLIFE.NS",
  "GRASIM.NS", "BAJAJFINSV.NS", "DRREDDY.NS", "CIPLA.NS", "COALINDIA.NS",
  "EICHERMOT.NS", "BRITANNIA.NS", "APOLLOHOSP.NS", "DIVISLAB.NS", "HEROMOTOCO.NS",
  "BPCL.NS", "INDUSINDBK.NS", "BAJAJ-AUTO.NS", "TATACONSUM.NS", "ONGC.NS",
  "SBILIFE.NS", "HINDALCO.NS", "ADANIPORTS.NS", "UPL.NS", "LTIM.NS",
];

// NIFTY Next 50 — the large-caps just below the NIFTY 50. Added so the India
// Scanner has a wider (~100-name) universe to screen than the 50 the research
// pipeline rotates through. Still a static list (no free India screen API), so
// the India scan is honestly capped at ~NIFTY-100, not the full ~2000 NSE.
export const NIFTY_NEXT_50: string[] = [
  "ADANIGREEN.NS", "ADANIPOWER.NS", "AMBUJACEM.NS", "DMART.NS", "BANKBARODA.NS",
  "BERGEPAINT.NS", "BEL.NS", "BOSCHLTD.NS", "CANBK.NS", "CHOLAFIN.NS",
  "COLPAL.NS", "DABUR.NS", "DLF.NS", "GAIL.NS", "GODREJCP.NS",
  "HAVELLS.NS", "HDFCAMC.NS", "ICICIGI.NS", "ICICIPRULI.NS", "IOC.NS",
  "INDIGO.NS", "NAUKRI.NS", "JINDALSTEL.NS", "JIOFIN.NS", "SIEMENS.NS",
  "PIDILITIND.NS", "PNB.NS", "PFC.NS", "RECLTD.NS", "MOTHERSON.NS",
  "SHREECEM.NS", "SRF.NS", "TATAPOWER.NS", "TORNTPHARM.NS", "TVSMOTOR.NS",
  "VBL.NS", "VEDL.NS", "ZOMATO.NS", "ZYDUSLIFE.NS", "IRCTC.NS",
  "MARICO.NS", "MPHASIS.NS", "MUTHOOTFIN.NS", "PAGEIND.NS", "AUROPHARMA.NS",
  "LODHA.NS", "TIINDIA.NS", "CGPOWER.NS", "POLYCAB.NS", "ABB.NS",
];

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Order the full NSE list for the nightly screen-cache refresh: never-scored names
 * first, then oldest scored_at. Ties are broken by a per-day hash, NOT by input
 * order. The NSE file is sorted by symbol and the previous comparator returned 0
 * for two never-scored names, so the stable sort left them alphabetical and every
 * run's 600-name slice started at A. Measured 2026-09-28: cached names by first
 * letter ran A 238/267 ... P 104/147, then R 2/112, S 6/347, T 9/137, V 2/85, so
 * SDBL and most of R-Z were never screened, never researched. The seed changes
 * daily so the slice walks a different part of the list each night.
 */
export function orderUniverseForRefresh(universe: string[], scoredAt: Map<string, string>, seed: string): string[] {
  const tie = (symbol: string) => fnv1a(`${seed}|${symbol}`);
  return [...universe].sort((a, b) => {
    const ta = scoredAt.get(a);
    const tb = scoredAt.get(b);
    if (ta == null && tb != null) return -1;
    if (ta != null && tb == null) return 1;
    if (ta != null && tb != null && ta !== tb) return ta.localeCompare(tb);
    return tie(a) - tie(b) || a.localeCompare(b);
  });
}

// ~NIFTY-100 union — the India Scanner's screen universe.
export function indiaScreenUniverse(): string[] {
  return [...new Set([...NIFTY_50, ...NIFTY_NEXT_50])];
}

// Take the top N as daily candidates (rotate later if we want variety).
export function niftyCandidates(n = 8): string[] {
  return NIFTY_50.slice(0, n);
}
