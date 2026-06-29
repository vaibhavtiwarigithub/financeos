import { createServiceClient } from "@/lib/supabase/service";
import PortfolioPage from "@/components/dashboard/PortfolioPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: portfolioArr },
    { data: positions },
    { data: trades },
    { data: perf },
    { data: signals },
    { data: pendingSignals },
    { data: strategyArr },
    { data: tradeQueueArr },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*").order("opened_at", { ascending: false }),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(50),
    supabase.from("paper_performance").select("*").order("date", { ascending: true }).limit(60),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(20),
    supabase.from("agent_signals").select("*, research_packets(*)").eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("agent_signals").select("id, symbol, direction, analyst_score, conviction, rationale, created_at").eq("status", "pending").gte("analyst_score", 60).order("analyst_score", { ascending: false }).limit(20),
  ]);

  return (
    <PortfolioPage
      portfolio={portfolioArr?.[0] ?? null}
      positions={positions ?? []}
      trades={trades ?? []}
      perf={perf ?? []}
      signals={signals ?? []}
      pendingSignals={pendingSignals ?? []}
      strategy={strategyArr?.[0] ?? null}
      tradeQueue={tradeQueueArr ?? []}
    />
  );
}
