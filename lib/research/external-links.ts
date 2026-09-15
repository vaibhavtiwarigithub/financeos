// Reference links shown beside a research entry. Plain hyperlinks the browser
// opens — never fetched by the server. They live here rather than in the
// Research Journal route so that viewer-reachable route stays free of outbound
// URLs, which tests/viewer-route-sweep.test.ts enforces.
export function externalLinks(symbol: string, market: "us" | "india", assetType: string) {
  const upper = symbol.trim().toUpperCase();
  const base = upper.replace(/\.(NS|BO)$/, "");
  return market === "india" ? [
    { label: "TradingView", url: `https://www.tradingview.com/symbols/NSE-${encodeURIComponent(base)}/` },
    { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(upper)}` },
    { label: "NSE", url: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(base)}` },
  ] : [
    { label: "TradingView", url: `https://www.tradingview.com/symbols/${encodeURIComponent(upper)}/` },
    { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(upper)}` },
    { label: assetType === "etf" || assetType === "metal_fund" ? "SEC / fund filings" : "SEC company filings", url: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(upper)}` },
  ];
}
