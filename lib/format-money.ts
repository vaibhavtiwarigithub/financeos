// Market-aware money formatting. US groups by thousands ($1,234,567); India uses
// the lakh/crore system — first three digits then every two (₹12,34,567) and the
// L/Cr abbreviations (₹1.5L = 1,50,000; ₹2.3Cr = 2,30,00,000). Use these EVERYWHERE
// a ₹ value is shown so India numbers read the Indian way, never US-grouped.

export type Mkt = "us" | "india";

const symbol = (m: Mkt) => (m === "india" ? "₹" : "$");
const locale = (m: Mkt) => (m === "india" ? "en-IN" : "en-US");

// Full grouped amount, e.g. fmtMoney(847199.5, "india") => "₹8,47,199.50"
// fmtMoney(9979.65, "us") => "$9,979.65". Pass fractionDigits to control decimals.
export function fmtMoney(n: number, market: Mkt, fractionDigits = 2): string {
  if (!Number.isFinite(n)) return `${symbol(market)}0`;
  const abs = Math.abs(n).toLocaleString(locale(market), {
    minimumFractionDigits: 0,
    maximumFractionDigits: fractionDigits,
  });
  return `${n < 0 ? "-" : ""}${symbol(market)}${abs}`;
}

// Compact abbreviation in the market's own convention:
//   India: L (lakh, 1e5) / Cr (crore, 1e7)  →  ₹8.5L, ₹2.3Cr
//   US:    k (1e3) / M (1e6)                 →  $9.9k, $1.2M
export function fmtMoneyAbbrev(n: number, market: Mkt): string {
  if (!Number.isFinite(n)) return `${symbol(market)}0`;
  const sym = symbol(market);
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (market === "india") {
    if (abs >= 1e7) return `${sign}${sym}${(abs / 1e7).toFixed(2)}Cr`;
    if (abs >= 1e5) return `${sign}${sym}${(abs / 1e5).toFixed(2)}L`;
    if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}k`;
    return `${sign}${sym}${abs.toFixed(0)}`;
  }
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${sym}${abs.toFixed(0)}`;
}
