import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveDisplayWeights } from "@/lib/champion-weights";
import AgentsPage from "@/components/dashboard/AgentsPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Server component — can't call useMarket() (client-only context). Reads
  // the `mkt` cookie MarketProvider keeps in sync instead, same pattern the
  // Smart Money page already uses. Defaults to "us" for a first visit before
  // the cookie is ever set.
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: signals },
    weights,
    { data: strategyArr },
    { data: learningLog },
    { data: paperPortfolio },
    { data: paperPositions },
    { data: paperTrades },
    { data: paperPerf },
    { data: agentRuns },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*").eq("market", market).order("created_at", { ascending: false }).limit(20),
    // Per-market champion weights (NOT the vestigial global signal_weights row) so
    // US and India each show their own learned weights. Falls back to the static
    // per-risk-profile baseline when no champion is promoted.
    resolveDisplayWeights(supabase, market),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(10),
    supabase.from("paper_portfolio").select("*").eq("market", market).limit(1).maybeSingle(),
    supabase.from("paper_positions").select("*").eq("market", market),
    supabase.from("paper_trades").select("*").eq("market", market).order("executed_at", { ascending: false }).limit(20),
    supabase.from("paper_performance").select("*").eq("market", market).order("date", { ascending: true }).limit(30),
    // agent_runs.market defaults to 'us' for agents that don't run per-market
    // (learner, mentor, macro-sentinel) — a few pre-077 rows never got
    // backfilled, so "us" also accepts null rather than hiding them.
    market === "india"
      ? supabase.from("agent_runs").select("*").eq("market", "india").order("started_at", { ascending: false }).limit(40)
      : supabase.from("agent_runs").select("*").or("market.eq.us,market.is.null").order("started_at", { ascending: false }).limit(40),
  ]);

  const strategy = strategyArr?.[0] ?? null;

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
      market={market}
    />
  );
}
