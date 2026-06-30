import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import DashboardHome from "@/components/dashboard/DashboardHome";
import { redirect } from "next/navigation";

export const revalidate = 30;

export default async function DashboardPage() {
  // getSession() reads from cookie — no network round-trip unlike getUser()
  const authClient = await createClient();
  const { data: { session } } = await authClient.auth.getSession();
  if (!session) redirect("/login");

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
    { data: liveSnap },
    { data: latestBriefing },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", session.user.id).single(),
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*"),
    supabase.from("paper_trades").select("*").gte("executed_at", sevenDaysAgo).order("executed_at", { ascending: false }),
    supabase.from("agent_runs").select("*").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false }),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(6),
    supabase.from("agent_signals").select("*").eq("status", "pending").gte("analyst_score", 55).order("analyst_score", { ascending: false }).limit(5),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(3),
    supabase.from("live_account_snapshots").select("*").order("captured_at", { ascending: false }).limit(1).single(),
    supabase.from("briefings").select("*").order("created_at", { ascending: false }).limit(1).single(),
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
      liveSnap={liveSnap ?? null}
      latestBriefing={latestBriefing ?? null}
    />
  );
}
