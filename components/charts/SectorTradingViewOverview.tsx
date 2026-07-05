"use client";
import { useState } from "react";
import TradingViewChart from "@/components/charts/TradingViewChart";

const T = {
  card: "#1A1D27", border: "#252836", text: "#ECEDEF", textSub: "#9B9EA8",
  muted: "#6B7280", accent: "#6366F1",
};

const SECTORS: { symbol: string; name: string }[] = [
  { symbol: "AMEX:XLK", name: "Technology" },
  { symbol: "AMEX:XLF", name: "Financials" },
  { symbol: "AMEX:XLE", name: "Energy" },
  { symbol: "AMEX:XLV", name: "Healthcare" },
  { symbol: "AMEX:XLI", name: "Industrials" },
  { symbol: "AMEX:XLY", name: "Consumer Disc." },
  { symbol: "AMEX:XLC", name: "Comm. Services" },
  { symbol: "AMEX:XLP", name: "Consumer Staples" },
  { symbol: "AMEX:XLU", name: "Utilities" },
  { symbol: "AMEX:XLRE", name: "Real Estate" },
  { symbol: "AMEX:XLB", name: "Materials" },
];

// Same TradingViewChart component (real tv.js Advanced Chart widget) used on
// the symbol detail page — full toolbar, indicators, real period buttons
// (1D/5D/1M/3M/6M/YTD/1Y/5Y/All), TradingView's own data. One sector ETF at a
// time via tabs; TradingView's free widgets don't support a single combined
// multi-symbol overlay/correlation chart (that needs custom data).
export default function SectorTradingViewOverview() {
  const [active, setActive] = useState(SECTORS[0]);

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: "12px", padding: "20px" }}>
      <div style={{ fontSize: "11px", color: T.muted, fontWeight: 500, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: "12px" }}>
        Sector Charts · TradingView
      </div>
      <div style={{ display: "flex", gap: "4px", flexWrap: "wrap", marginBottom: "16px" }}>
        {SECTORS.map(s => (
          <button
            key={s.symbol}
            onClick={() => setActive(s)}
            style={{
              padding: "6px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: 600,
              cursor: "pointer", border: "none",
              background: active.symbol === s.symbol ? T.accent : "#13151C",
              color: active.symbol === s.symbol ? "#fff" : T.textSub,
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      <TradingViewChart key={active.symbol} symbol={active.symbol} height={460} />
    </div>
  );
}
