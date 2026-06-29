import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import DashboardHome from "@/components/dashboard/DashboardHome";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) redirect("/login");

  const supabase = createServiceClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: profile },
    { data: paperPortfolioArr },
    { data: positions },
    { data: recentTrades },
    { data: recentRuns },
    { data: recentSignals },
    { data: pendingSignals },
    { data: recentLog },
  ] = await Promise.all([
    userClient.from("profiles").select("*").eq("id", user.id).single(),
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*"),
    supabase.from("paper_trades").select("*").gte("executed_at", sevenDaysAgo).order("executed_at", { ascending: false }),
    supabase.from("agent_runs").select("*").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false }),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(6),
    supabase.from("agent_signals").select("*").eq("status", "pending").gte("analyst_score", 55).order("analyst_score", { ascending: false }).limit(5),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(3),
  ]);

  return (
    <DashboardHome
      profile={profile}
      paperPortfolio={paperPortfolioArr?.[0] ?? null}
      positions={positions ?? []}
      recentTrades={recentTrades ?? []}
      recentRuns={recentRuns ?? []}
      recentSignals={recentSignals ?? []}
      pendingSignals={pendingSignals ?? []}
      recentLog={recentLog ?? []}
    />
  );
}
