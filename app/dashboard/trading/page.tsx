import { createClient } from "@/lib/supabase/server";
import TradingPage from "@/components/dashboard/TradingPage";

export default async function Page() {
  const supabase = await createClient();

  const [
    { data: queue },
    { data: tradeLog },
    { data: strategyArr },
  ] = await Promise.all([
    supabase.from("trade_queue").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("trade_log").select("*").order("executed_at", { ascending: false }).limit(30),
    supabase.from("strategy_config").select("*").limit(1),
  ]);

  const strategy = strategyArr?.[0] ?? null;

  return <TradingPage queue={queue ?? []} tradeLog={tradeLog ?? []} strategy={strategy} />;
}
