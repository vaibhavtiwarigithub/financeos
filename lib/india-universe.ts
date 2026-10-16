// Static NIFTY-50 fallback snapshot (NSE `.NS` tickers). Current research and
// refresh paths prefer the official NSE Indices constituent CSV; this list is
// retained for source outages and historical helpers, not treated as current.
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
export function orderUniverseForRefresh(
  universe: string[],
  scoredAt: Map<string, string>,
  seed: string,
  prioritySymbols: string[] = [],
): string[] {
  const tie = (symbol: string) => fnv1a(`${seed}|${symbol}`);
  const known = new Set(universe.map((symbol) => symbol.toUpperCase()));
  const prioritySet = new Set(prioritySymbols.map((symbol) => symbol.toUpperCase()).filter((symbol) => known.has(symbol)));
  return [...universe].sort((a, b) => {
    const ap = prioritySet.has(a.toUpperCase());
    const bp = prioritySet.has(b.toUpperCase());
    if (ap !== bp) return ap ? -1 : 1;
    const ta = scoredAt.get(a);
    const tb = scoredAt.get(b);
    if (ta == null && tb != null) return -1;
    if (ta != null && tb == null) return 1;
    if (ta != null && tb != null && ta !== tb) return ta.localeCompare(tb);
    return tie(a) - tie(b) || a.localeCompare(b);
  });
}

/**
 * Keep the core index refresh reserve even when the broad-universe liquidity
 * prefilter excludes a member. The prefilter still orders the rest of the
 * 600-name budget; this function only guarantees that prioritized names present
 * in the NSE directory are attempted first.
 */
export function buildIndiaRefreshSlice(input: {
  orderedUniverse: string[];
  prioritySymbols: string[];
  preferredUniverse: string[];
  limit: number;
}): string[] {
  const limit = Math.max(0, Math.floor(input.limit));
  const prioritySet = new Set(input.prioritySymbols.map((symbol) => symbol.toUpperCase()));
  const prioritized = input.orderedUniverse.filter((symbol) => prioritySet.has(symbol.toUpperCase()));
  const preferred = input.preferredUniverse.filter((symbol) => !prioritySet.has(symbol.toUpperCase()));
  const remainder = input.orderedUniverse.filter((symbol) => !prioritySet.has(symbol.toUpperCase()));
  return [...new Set([...prioritized, ...preferred, ...remainder])].slice(0, limit);
}

/**
 * Candidate research order for India. Four of the default eight candidate
 * slots are reserved for a rotating NIFTY-50 coverage lane (after explicit
 * manual watchlist names); the remaining slots continue to use deferred,
 * curated and broad-screen candidates. The index lane is coverage, not a buy
 * endorsement: ResearchAgent rescoring and every downstream entry/risk gate
 * remain unchanged.
 */
export function buildIndiaCandidateOrder(input: {
  manual: string[];
  indexRotation: string[];
  deferred: string[];
  watchlist: string[];
  screened: string[];
  indexReserve?: number;
}): string[] {
  const reserve = Math.max(0, Math.floor(input.indexReserve ?? 4));
  const normalized = (symbols: string[]) => symbols.map((symbol) => {
    const upper = String(symbol).trim().toUpperCase();
    return upper && !upper.endsWith(".NS") && !upper.endsWith(".BO") ? `${upper}.NS` : upper;
  }).filter(Boolean);
  const manual = normalized(input.manual);
  const manualSet = new Set(manual);
  const index = normalized(input.indexRotation).filter((symbol) => !manualSet.has(symbol));
  const ordered = [
    ...manual,
    ...index.slice(0, reserve),
    ...normalized(input.deferred),
    ...normalized(input.watchlist),
    ...normalized(input.screened),
    ...index.slice(reserve),
  ];
  return [...new Set(ordered)];
}

// ~NIFTY-100 union — the India Scanner's screen universe.
export function indiaScreenUniverse(): string[] {
  return [...new Set([...NIFTY_50, ...NIFTY_NEXT_50])];
}

// Take the top N as daily candidates (rotate later if we want variety).
export function niftyCandidates(n = 8): string[] {
  return NIFTY_50.slice(0, n);
}
