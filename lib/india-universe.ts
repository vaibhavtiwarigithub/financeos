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

// Take the top N as daily candidates (rotate later if we want variety).
export function niftyCandidates(n = 8): string[] {
  return NIFTY_50.slice(0, n);
}
