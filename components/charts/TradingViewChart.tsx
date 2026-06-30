"use client";
import { useEffect, useRef } from "react";

declare global {
  interface Window { TradingView: any; }
}

const T = {
  bg: "#0D0F14", card: "#1A1D27", border: "#252836",
  green: "#34D399", red: "#F87171",
};

export default function TradingViewChart({ symbol, height = 520 }: { symbol: string; height?: number }) {
  const idRef = useRef(`tv_${symbol.replace(/[^a-zA-Z0-9]/g, "_")}`);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    function initWidget() {
      if (!window.TradingView || !containerRef.current) return;
      new window.TradingView.widget({
        container_id: idRef.current,
        autosize: true,
        symbol: symbol,
        interval: "D",
        timezone: "America/New_York",
        theme: "dark",
        style: "1",
        locale: "en",
        backgroundColor: T.bg,
        gridColor: T.border,
        toolbar_bg: T.card,
        enable_publishing: false,
        withdateranges: true,
        range: "12M",
        hide_side_toolbar: false,
        allow_symbol_change: false,
        save_image: false,
        show_popup_button: false,
        studies: [
          "Volume@tv-basicstudies",
        ],
        overrides: {
          "mainSeriesProperties.candleStyle.upColor": T.green,
          "mainSeriesProperties.candleStyle.downColor": T.red,
          "mainSeriesProperties.candleStyle.borderUpColor": T.green,
          "mainSeriesProperties.candleStyle.borderDownColor": T.red,
          "mainSeriesProperties.candleStyle.wickUpColor": T.green,
          "mainSeriesProperties.candleStyle.wickDownColor": T.red,
        },
      });
    }

    if (window.TradingView) {
      initWidget();
    } else {
      const existing = document.querySelector('script[src*="tradingview.com/tv.js"]');
      if (existing) {
        existing.addEventListener("load", initWidget);
      } else {
        const script = document.createElement("script");
        script.src = "https://s3.tradingview.com/tv.js";
        script.async = true;
        script.onload = initWidget;
        document.head.appendChild(script);
      }
    }
  }, [symbol]);

  return (
    <div style={{ width: "100%", height, background: T.bg, borderRadius: "14px", overflow: "hidden", border: `1px solid ${T.border}` }}>
      <div id={idRef.current} ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
