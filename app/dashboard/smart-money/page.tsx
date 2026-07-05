import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import SmartMoneyPage from "@/components/dashboard/SmartMoneyPage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Scope signal/trade-queue tiles to the selected market (mkt cookie). India has
// no free insider/options feed, so those tiles render a muted "US only" state
// client-side. Every market-scoped query is resilient: if the `market` column
// doesn't exist yet (pre-057), we retry without the filter and fall back to US.
async function selectScoped<T>(
  run: (applyMarket: boolean) => PromiseLike<{ data: T | null; error: unknown }>
): Promise<T | null> {
  const withFilter = await run(true);
  if (!withFilter.error) return withFilter.data;
  // Column-missing or other filter error — retry unscoped so US path is unchanged.
  const unscoped = await run(false);
  return unscoped.data;
}

export default async function Page() {
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const svc = createServiceClient();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [signals, tradeQueue, highInsider] = await Promise.all([
    selectScoped<any[]>((applyMarket) => {
      let q = svc
        .from("agent_signals")
        .select("symbol,direction,analyst_score,insider_score,technical_score,fundamental_score,sentiment_score,macro_score,created_at,asset_class,source")
        .gte("created_at", since30);
      if (applyMarket) q = q.eq("market", market);
      return q.order("analyst_score", { ascending: false }).limit(60);
    }),
    selectScoped<any[]>((applyMarket) => {
      let q = svc
        .from("trade_queue")
        .select("*")
        .in("status", ["pending_approval", "approved", "executed", "rejected"]);
      if (applyMarket) q = q.eq("market", market);
      return q.order("created_at", { ascending: false }).limit(30);
    }),
    selectScoped<any[]>((applyMarket) => {
      let q = svc
        .from("agent_signals")
        .select("symbol,analyst_score,insider_score,direction,created_at,asset_class")
        .gte("created_at", since7)
        .gte("insider_score", 55);
      if (applyMarket) q = q.eq("market", market);
      return q.order("insider_score", { ascending: false }).limit(20);
    }),
  ]);

  return (
    <SmartMoneyPage
      signals={signals ?? []}
      tradeQueue={tradeQueue ?? []}
      highInsider={highInsider ?? []}
      market={market}
    />
  );
}
