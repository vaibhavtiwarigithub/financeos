"use client";
// Global market selection (us | india). One switcher in the DashboardShell sets
// it; any client panel reads it via useMarket() and scopes its data/currency to
// the chosen country. Persisted to localStorage so it survives navigation.
//
// Server-component pages can't call this hook — they should read the `mkt` cookie
// (kept in sync here) or delegate rendering to a client child that uses useMarket.

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { useRouter } from "next/navigation";

export type Market = "us" | "india";
export const CURRENCY: Record<Market, string> = { us: "$", india: "₹" };
export const MARKET_LABEL: Record<Market, string> = { us: "🇺🇸 US", india: "🇮🇳 India" };

type Ctx = { market: Market; setMarket: (m: Market) => void; indiaEnabled: boolean };
const MarketCtx = createContext<Ctx>({ market: "us", setMarket: () => {}, indiaEnabled: false });

export function MarketProvider({ children, indiaEnabled }: { children: ReactNode; indiaEnabled: boolean }) {
  const [market, setMarketState] = useState<Market>("us");
  const router = useRouter();

  // Restore persisted choice on mount and keep state, localStorage AND the `mkt`
  // cookie in agreement — otherwise server components (which read the cookie) can
  // render US while the client shows India, or a stale India cookie survives after
  // India is disabled in market_focus.
  useEffect(() => {
    let saved: Market | null = null;
    try { saved = localStorage.getItem("kairos_market") as Market | null; } catch { /* no localStorage */ }
    const next: Market = saved === "india" && indiaEnabled ? "india" : "us";
    setMarketState(next);
    try {
      localStorage.setItem("kairos_market", next);
      document.cookie = `mkt=${next}; path=/; max-age=31536000; samesite=lax`;
    } catch { /* ignore */ }
  }, [indiaEnabled]);

  const setMarket = (m: Market) => {
    const next: Market = m === "india" && indiaEnabled ? "india" : "us";
    setMarketState(next);
    try {
      localStorage.setItem("kairos_market", next);
      document.cookie = `mkt=${next}; path=/; max-age=31536000; samesite=lax`;
    } catch { /* ignore */ }
    // Server components (e.g. the Home hero) read the `mkt` cookie at render time —
    // refresh the current route so they re-render for the new market instead of
    // staying pinned to whatever was rendered on the last navigation.
    try { router.refresh(); } catch { /* ignore */ }
  };

  return <MarketCtx.Provider value={{ market, setMarket, indiaEnabled }}>{children}</MarketCtx.Provider>;
}

export function useMarket(): Ctx {
  return useContext(MarketCtx);
}

// Segmented US/India toggle for the shell header. Renders nothing when India
// isn't enabled (market_focus) — so a US-only user never sees clutter.
export function MarketSwitcher() {
  const { market, setMarket, indiaEnabled } = useMarket();
  if (!indiaEnabled) return null;
  const opts: Market[] = ["us", "india"];
  return (
    <div style={{ display: "inline-flex", gap: "2px", padding: "2px", borderRadius: "8px", background: "#0F1117", border: "1px solid #252836" }}>
      {opts.map((m) => {
        const active = market === m;
        return (
          <button key={m} type="button" onClick={() => setMarket(m)}
            title={`Show ${m === "india" ? "India (₹)" : "US ($)"} across the app`}
            style={{
              padding: "3px 10px", borderRadius: "6px", fontSize: "12px", fontWeight: 600, cursor: "pointer", border: "none",
              background: active ? "#6366F1" : "transparent",
              color: active ? "#fff" : "#9B9EA8",
            }}>{MARKET_LABEL[m]}</button>
        );
      })}
    </div>
  );
}
