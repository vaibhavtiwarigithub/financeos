import PropertyMarketData from "@/components/property/PropertyMarketData";
import { PROPERTY_MARKETS, type PropertyMarketId } from "@/lib/property/registry";

export default async function PropertyMarketsPage({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  const requested = (await searchParams).market;
  const marketId = PROPERTY_MARKETS.some((market) => market.id === requested) ? requested as PropertyMarketId : undefined;
  return <PropertyMarketData marketId={marketId} />;
}
