// Edge/Factor Discovery — curated liquid universe. MEASURE-ONLY.
//
// HONESTY: this is a STATIC, CURRENT-liquid list of well-known large/mid-cap names
// across sectors. It is NOT point-in-time index membership — it embeds survivorship
// bias (only names that exist today, chosen with hindsight). It exists so IC can be
// computed on a BROAD cross-section instead of a 30-name watchlist, which makes the
// IC less noisy — but IC on this list is still NOT proof (see FEATURE_ARCHITECTURE
// §13). True PIT membership is a later phase. Unknown/delisted tickers are simply
// reported as `unavailable` by the resolver and skipped — a stray bad symbol is
// harmless, not fatal.
//
// Individual stocks only (no ETFs) — the benchmark (SPY/NIFTY) is handled separately.

export const US_LIQUID: string[] = [
  // Mega-cap tech / AI / semis
  "AAPL","MSFT","NVDA","GOOGL","GOOG","AMZN","META","TSLA","AVGO","AMD","INTC","QCOM","TXN",
  "MU","AMAT","LRCX","KLAC","ADI","MRVL","NXPI","ON","MCHP","ASML","TSM","ARM","SMCI","DELL",
  "ORCL","CRM","ADBE","NOW","INTU","CSCO","IBM","ACN","PANW","SNPS","CDNS","ANET","CRWD","FTNT",
  // Comms / media / internet
  "NFLX","DIS","CMCSA","T","VZ","TMUS","UBER","ABNB","BKNG","SHOP","PYPL","SQ",
  // Financials
  "JPM","BAC","WFC","GS","MS","C","SCHW","BLK","AXP","SPGI","BX","V","MA","COF",
  // Health
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","DHR","BMY","AMGN","GILD","ISRG","MDT","CVS","VRTX",
  // Consumer
  "WMT","COST","HD","LOW","TGT","PG","KO","PEP","MCD","SBUX","NKE","MDLZ","CL","PM","MO",
  // Industrials / defense
  "CAT","DE","HON","GE","BA","LMT","RTX","UNP","UPS","MMM","EMR","ETN","PH",
  // Energy / power / nuclear
  "XOM","CVX","COP","SLB","EOG","PSX","MPC","OXY","WMB","KMI",
  "NEE","DUK","SO","CEG","VST","D","AEP","EXC","XEL",
  // Materials / misc
  "LIN","FCX","NEM","NUE","DOW","APD",
];

// India (NSE, .NS) — liquid NIFTY-100-ish names across sectors.
export const INDIA_LIQUID: string[] = [
  "RELIANCE.NS","TCS.NS","HDFCBANK.NS","ICICIBANK.NS","INFY.NS","HINDUNILVR.NS","ITC.NS",
  "SBIN.NS","BHARTIARTL.NS","KOTAKBANK.NS","LT.NS","AXISBANK.NS","BAJFINANCE.NS","ASIANPAINT.NS",
  "MARUTI.NS","HCLTECH.NS","SUNPHARMA.NS","TITAN.NS","ULTRACEMCO.NS","WIPRO.NS","NESTLEIND.NS",
  "ONGC.NS","NTPC.NS","POWERGRID.NS","M&M.NS","TATAMOTORS.NS","TATASTEEL.NS","JSWSTEEL.NS",
  "ADANIENT.NS","ADANIPORTS.NS","COALINDIA.NS","BAJAJFINSV.NS","HDFCLIFE.NS","SBILIFE.NS",
  "TECHM.NS","GRASIM.NS","HINDALCO.NS","DRREDDY.NS","CIPLA.NS","DIVISLAB.NS","EICHERMOT.NS",
  "BRITANNIA.NS","BPCL.NS","IOC.NS","TATACONSUM.NS","APOLLOHOSP.NS","BAJAJ-AUTO.NS","HEROMOTOCO.NS",
  "INDUSINDBK.NS","SHRIRAMFIN.NS","LTIM.NS","DMART.NS","PIDILITIND.NS","DABUR.NS","GAIL.NS",
  "SIEMENS.NS","VEDL.NS","AMBUJACEM.NS",
];

export function liquidUniverse(market: "us" | "india"): string[] {
  return market === "india" ? INDIA_LIQUID : US_LIQUID;
}
