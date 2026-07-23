"use client";
import React from "react";

// TradingView chart URL per market. For India we prefix NSE: so TV resolves
// the correct exchange. US tickers resolve without prefix.
function tvUrl(symbol: string, market: "us" | "india"): string {
  const sym = symbol.toUpperCase();
  return market === "india"
    ? `https://www.tradingview.com/chart/?symbol=NSE:${sym}`
    : `https://www.tradingview.com/chart/?symbol=${sym}`;
}

/**
 * Wrap any symbol with a TradingView link. Use this for every symbol that
 * appears in a table, list, or card across the whole app.
 *
 * Usage:
 *   <SymbolLink symbol="AAPL" />                       → "AAPL" → TV US
 *   <SymbolLink symbol="RELIANCE" market="india" />    → "RELIANCE" → TV NSE
 *   <SymbolLink symbol="SMCI" style={{ color: "#fff" }}>SMCI ↗</SymbolLink>
 */
export function SymbolLink({
  symbol,
  market = "us",
  style,
  className,
  children,
}: {
  symbol: string;
  market?: "us" | "india";
  style?: React.CSSProperties;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <a
      href={tvUrl(symbol, market)}
      target="_blank"
      rel="noopener noreferrer"
      title={`Open ${symbol.toUpperCase()} on TradingView`}
      className={className}
      style={{ textDecoration: "none", cursor: "pointer", ...style }}
      onClick={e => e.stopPropagation()}
    >
      {children ?? symbol.toUpperCase()}
    </a>
  );
}
