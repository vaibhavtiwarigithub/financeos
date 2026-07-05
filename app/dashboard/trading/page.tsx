import { createServiceClient } from "@/lib/supabase/service";
import TradingPage from "@/components/dashboard/TradingPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: signals },
    { data: trades },
    { data: strategyArr },
    { data: portfolio },
    { data: highScoreSignals },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*, research_packets(*)").eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(30),
    supabase.from("strategy_config").select("*").limit(1),
    // Phase 4: US pool only (post-057 there's also an India ₹ row). maybeSingle so a missing market column pre-057 yields null gracefully.
    supabase.from("paper_portfolio").select("*").eq("market", "us").limit(1).maybeSingle(),
    supabase.from("agent_signals").select("id, symbol, direction, analyst_score, conviction, rationale, created_at, status").eq("status", "pending").gte("analyst_score", 60).order("analyst_score", { ascending: false }).limit(20),
  ]);

  return (
    <TradingPage
      pendingSignals={signals ?? []}
      tradeLog={trades ?? []}
      strategy={strategyArr?.[0] ?? null}
      portfolio={portfolio ?? null}
      queue={highScoreSignals ?? []}
    />
  );
}
