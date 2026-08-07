import PropertyMarketData from "@/components/property/PropertyMarketData";
import { marketById } from "@/lib/property/registry";

export default async function PropertyMarketsPage({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  const market = marketById((await searchParams).market);
  return <PropertyMarketData marketId={market.id} />;
}
