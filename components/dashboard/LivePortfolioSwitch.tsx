"use client";
import { useMarket } from "@/lib/market-context";
import LivePortfolioPage from "@/components/dashboard/LivePortfolioPage";
import IndiaLivePanel from "@/components/dashboard/IndiaLivePanel";

type UsProps = {
  liveSnaps: any[];
  initialFiles: any[];
  decisionStats: { total: number; enriched: number; pending: number };
};

// Single live-portfolio route that follows the global US/India switch:
// India → live Zerodha Kite panel (self-fetching); US → Robinhood live view.
export default function LivePortfolioSwitch({ usProps }: { usProps: UsProps }) {
  const { market } = useMarket();
  return market === "india" ? <IndiaLivePanel /> : <LivePortfolioPage {...usProps} />;
}
