"use client";
import { useEffect, useRef } from "react";

const T = {
  card: "#1A1D27",
  border: "#252836",
};

const SECTORS: [string, string][] = [
  ["AMEX:XLK", "Technology"],
  ["AMEX:XLF", "Financials"],
  ["AMEX:XLE", "Energy"],
  ["AMEX:XLV", "Healthcare"],
  ["AMEX:XLI", "Industrials"],
  ["AMEX:XLY", "Consumer Disc."],
  ["AMEX:XLC", "Comm. Services"],
  ["AMEX:XLP", "Consumer Staples"],
  ["AMEX:XLU", "Utilities"],
  ["AMEX:XLRE", "Real Estate"],
  ["AMEX:XLB", "Materials"],
];

// TradingView's own free "Symbol Overview" widget. Real historical depth and
// TradingView's own period tabs (1D/1M/3M/1Y/5Y/ALL) — no Massive API calls,
// no rate limits, no pagination to maintain. Renders each sector ETF as its
// own mini-chart (TradingView doesn't offer a free multi-symbol overlay/
// correlation widget — that needs custom data, which is what the old
// lightweight-charts version did).
export default function SectorTradingViewOverview() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = "";

    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    container.appendChild(widgetDiv);

    const script = document.createElement("script");
    script.type = "text/javascript";
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-symbol-overview.js";
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbols: SECTORS.map(([symbol, name]) => [`${name}|${symbol}`]),
      chartOnly: false,
      width: "100%",
      height: "460",
      locale: "en",
      colorTheme: "dark",
      autosize: false,
      showVolume: false,
      showMA: false,
      hideDateRanges: false,
      hideMarketStatus: false,
      hideSymbolLogo: false,
      scalePosition: "right",
      scaleMode: "Normal",
      fontFamily: "Trebuchet MS, sans-serif",
      fontSize: "10",
      noTimeScale: false,
      valuesTracking: "1",
      changeMode: "price-and-percent",
      backgroundColor: T.card,
      gridLineColor: T.border,
      lineWidth: 2,
      lineType: 0,
      dateRanges: ["1d|1", "1m|30", "3m|60", "12m|1D", "60m|1W", "all|1M"],
    });
    container.appendChild(script);
  }, []);

  return (
    <div
      style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: "12px",
        padding: "12px",
        minHeight: "460px",
      }}
    >
      <div className="tradingview-widget-container" ref={containerRef} style={{ height: "460px", width: "100%" }} />
    </div>
  );
}
