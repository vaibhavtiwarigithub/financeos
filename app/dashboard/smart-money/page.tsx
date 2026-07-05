import { createServiceClient } from "@/lib/supabase/service";
import SmartMoneyPage from "@/components/dashboard/SmartMoneyPage";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function Page() {
  const svc = createServiceClient();
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const since7 = new Date(Date.now() - 7 * 86400_000).toISOString();

  const [
    { data: signals },
    { data: tradeQueue },
    { data: highInsider },
  ] = await Promise.all([
    svc.from("agent_signals").select("symbol,direction,analyst_score,insider_score,technical_score,fundamental_score,sentiment_score,macro_score,created_at,asset_class,source").gte("created_at", since30).order("analyst_score", { ascending: false }).limit(60),
    svc.from("trade_queue").select("*").in("status", ["pending_approval","approved","executed","rejected"]).order("created_at", { ascending: false }).limit(30),
    svc.from("agent_signals").select("symbol,analyst_score,insider_score,direction,created_at,asset_class").gte("created_at", since7).gte("insider_score", 55).order("insider_score", { ascending: false }).limit(20),
  ]);

  return <SmartMoneyPage signals={signals ?? []} tradeQueue={tradeQueue ?? []} highInsider={highInsider ?? []} />;
}
