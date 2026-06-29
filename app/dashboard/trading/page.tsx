import { createServiceClient } from "@/lib/supabase/service";
import TradingPage from "@/components/dashboard/TradingPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: signals },
    { data: trades },
    { data: strategyArr },
    { data: portfolioArr },
    { data: highScoreSignals },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*, research_packets(*)").eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(30),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("agent_signals").select("id, symbol, direction, analyst_score, conviction, rationale, created_at, status").eq("status", "pending").gte("analyst_score", 60).order("analyst_score", { ascending: false }).limit(20),
  ]);

  return (
    <TradingPage
      pendingSignals={signals ?? []}
      tradeLog={trades ?? []}
      strategy={strategyArr?.[0] ?? null}
      portfolio={portfolioArr?.[0] ?? null}
      queue={highScoreSignals ?? []}
    />
  );
}
