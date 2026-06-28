import { createServiceClient } from "@/lib/supabase/service";
import AgentsPage from "@/components/dashboard/AgentsPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: signals },
    { data: weights },
    { data: strategyArr },
    { data: learningLog },
    { data: paperPortfolioArr },
    { data: paperPositions },
    { data: paperTrades },
    { data: paperPerf },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(20),
    supabase.from("signal_weights").select("*").single(),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(10),
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*"),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(20),
    supabase.from("paper_performance").select("*").order("date", { ascending: true }).limit(30),
  ]);

  const strategy = strategyArr?.[0] ?? null;
  const paperPortfolio = paperPortfolioArr?.[0] ?? null;

  return (
    <AgentsPage
      signals={signals ?? []}
      weights={weights}
      strategy={strategy}
      learningLog={learningLog ?? []}
      paperPortfolio={paperPortfolio}
      paperPositions={paperPositions ?? []}
      paperTrades={paperTrades ?? []}
      paperPerf={paperPerf ?? []}
    />
  );
}
