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
    { data: paperPortfolio },
    { data: positions },
    { data: recentTrades },
    { data: recentRuns },
    { data: recentSignals },
    { data: pendingSignals },
    { data: recentLog },
    { data: liveSnap },
    { data: latestBriefing },
    { data: indiaPaperPortfolio },
    { data: indiaPositions },
    { data: indiaPendingSignals },
    { data: indiaRecentRuns },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", session.user.id).single(),
    // Phase 4: US pool only (post-057 there's also an India ₹ row). maybeSingle so a missing market column pre-057 yields null gracefully.
    supabase.from("paper_portfolio").select("*").eq("market", "us").limit(1).maybeSingle(),
    // Previously unfiltered — silently blended India positions into what the
    // hero card presents as the US NAV/positions count. Scoped to match
    // paperPortfolio above.
    supabase.from("paper_positions").select("*").eq("market", "us"),
    supabase.from("paper_trades").select("*").eq("market", "us").gte("executed_at", sevenDaysAgo).order("executed_at", { ascending: false }),
    supabase.from("agent_runs").select("*").or("market.eq.us,market.is.null").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false }),
    supabase.from("agent_signals").select("*").eq("market", "us").order("created_at", { ascending: false }).limit(6),
    supabase.from("agent_signals").select("*").eq("market", "us").eq("status", "pending").gte("analyst_score", 55).order("analyst_score", { ascending: false }).limit(5),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(3),
    // Filter to the Trading account (••••8641) specifically — without this,
    // "most recent snapshot" could silently return Autopilot or Agentic's
    // row instead, mislabeled under the hardcoded "••••8641" UI text.
    supabase.from("live_account_snapshots").select("*").eq("account_id", "965848641").order("captured_at", { ascending: false }).limit(1).single(),
    supabase.from("briefings").select("*").order("created_at", { ascending: false }).limit(1).single(),
    // India — Morning Briefing was US-only until now (a real gap: it always
    // showed the US pool regardless of the header switcher). Fetched
    // unconditionally (cheap, small result sets); DashboardHome only renders
    // this section when profile.market_focus actually enables India.
    supabase.from("paper_portfolio").select("*").eq("market", "india").limit(1).maybeSingle(),
    supabase.from("paper_positions").select("*").eq("market", "india"),
    supabase.from("agent_signals").select("*").eq("market", "india").eq("status", "pending").gte("analyst_score", 55).order("analyst_score", { ascending: false }).limit(5),
    supabase.from("agent_runs").select("*").eq("market", "india").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false }),
  ]);

  return (
    <DashboardHome
      profile={profile}
      paperPortfolio={paperPortfolio ?? null}
      positions={positions ?? []}
      recentTrades={recentTrades ?? []}
      recentRuns={recentRuns ?? []}
      recentSignals={recentSignals ?? []}
      pendingSignals={pendingSignals ?? []}
      recentLog={recentLog ?? []}
      liveSnap={liveSnap ?? null}
      latestBriefing={latestBriefing ?? null}
      indiaData={{
        paperPortfolio: indiaPaperPortfolio ?? null,
        positions: indiaPositions ?? [],
        pendingSignals: indiaPendingSignals ?? [],
        recentRuns: indiaRecentRuns ?? [],
      }}
    />
  );
}
