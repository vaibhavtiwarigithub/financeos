"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

const STORAGE_KEY = "kairos-property-market";

type PropertyMarketContextValue = {
  market: PropertyMarketId;
  setMarket: (market: PropertyMarketId) => void;
};

const PropertyMarketContext = createContext<PropertyMarketContextValue | null>(null);

export function PropertyMarketProvider({ children }: { children: ReactNode }) {
  const [market, setMarketState] = useState<PropertyMarketId>("austin");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (PROPERTY_MARKETS.some((item) => item.id === stored)) setMarketState(stored as PropertyMarketId);
  }, []);

  const setMarket = useCallback((next: PropertyMarketId) => {
    setMarketState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  }, []);
  const value = useMemo(() => ({ market, setMarket }), [market, setMarket]);

  return <PropertyMarketContext.Provider value={value}>{children}</PropertyMarketContext.Provider>;
}

export function usePropertyMarket(): PropertyMarketContextValue {
  const value = useContext(PropertyMarketContext);
  if (!value) throw new Error("usePropertyMarket must be used inside PropertyMarketProvider");
  return value;
}
