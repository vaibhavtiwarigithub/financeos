import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import TradingPage from "@/components/dashboard/TradingPage";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) redirect("/login");

  const supabase = createServiceClient();

  const [
    { data: signals },
    { data: trades },
    { data: strategyArr },
    { data: portfolioArr },
  ] = await Promise.all([
    supabase.from("agent_signals").select("*, research_packets(*)").eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(30),
    supabase.from("strategy_config").select("*").limit(1),
    supabase.from("paper_portfolio").select("*").limit(1),
  ]);

  return (
    <TradingPage
      pendingSignals={signals ?? []}
      tradeLog={trades ?? []}
      strategy={strategyArr?.[0] ?? null}
      portfolio={portfolioArr?.[0] ?? null}
      queue={[]}
    />
  );
}
