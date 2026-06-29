import { createServiceClient } from "@/lib/supabase/service";
import AgentsPage from "@/components/dashboard/AgentsPage";

export const revalidate = 30;

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
    { data: agentRuns },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(20),
    supabase.from("signal_weights").select("*").single(),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(10),
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*"),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(20),
    supabase.from("paper_performance").select("*").order("date", { ascending: true }).limit(30),
    supabase.from("agent_runs").select("*").order("started_at", { ascending: false }).limit(40),
  ]);

  const strategy = strategyArr?.[0] ?? null;
  const paperPortfolio = paperPortfolioArr?.[0] ?? null;

  // Group runs by agent_type, last 5 each
  const runsByAgent: Record<string, any[]> = {};
  for (const run of agentRuns ?? []) {
    const key = (run as any).agent_type;
    if (!runsByAgent[key]) runsByAgent[key] = [];
    if (runsByAgent[key].length < 5) runsByAgent[key].push(run);
  }

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
      agentRuns={runsByAgent}
    />
  );
}
