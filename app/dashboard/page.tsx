import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import DashboardHome from "@/components/dashboard/DashboardHome";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { loadTradingMandate } from "@/lib/trading-mandate";

export const revalidate = 30;

export default async function DashboardPage() {
  // getSession() reads from cookie — no network round-trip unlike getUser()
  const authClient = await createClient();
  const { data: { session } } = await authClient.auth.getSession();
  if (!session) redirect("/login");

  const supabase = createServiceClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Server component — can't call useMarket() (client-only context). Read the
  // `mkt` cookie MarketProvider keeps in sync, same idiom as the Agents page,
  // so the PRIMARY Morning-Briefing hero (NAV/P&L/positions/trades/signals)
  // follows the global US/India switch instead of being pinned to US.
  const mkt = (await cookies()).get("mkt")?.value === "india" ? "india" : "us";
  const tradingMandate = await loadTradingMandate(supabase, mkt);

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
    { data: strategyConfig },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", session.user.id).single(),
    // Hero pool follows the global switch (mkt). maybeSingle so a missing market column pre-057 yields null gracefully.
    supabase.from("paper_portfolio").select("*").eq("market", mkt).limit(1).maybeSingle(),
    // Previously unfiltered — silently blended other-market positions into what
    // the hero card presents as NAV/positions count. Scoped to match
    // paperPortfolio above.
    supabase.from("paper_positions").select("*").eq("market", mkt),
    supabase.from("paper_trades").select("*").eq("market", mkt).gte("executed_at", sevenDaysAgo).order("executed_at", { ascending: false }),
    // agent_runs.market defaults to 'us' for cross-market agents (learner, mentor,
    // macro-sentinel); a few pre-077 rows are null, so "us" also accepts null.
    mkt === "india"
      ? supabase.from("agent_runs").select("*").eq("market", "india").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false })
      : supabase.from("agent_runs").select("*").or("market.eq.us,market.is.null").gte("completed_at", sevenDaysAgo).order("completed_at", { ascending: false }),
    supabase.from("agent_signals").select("*").eq("market", mkt).order("created_at", { ascending: false }).limit(6),
    supabase.from("agent_signals").select("*").eq("market", mkt).eq("status", "pending").gte("analyst_score", Math.max(0, tradingMandate.score_threshold - 5)).order("analyst_score", { ascending: false }).limit(5),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(3),
    // Filter to the Trading account (••••8641) specifically — without this,
    // "most recent snapshot" could silently return Autopilot or Agentic's
    // row instead, mislabeled under the hardcoded "••••8641" UI text.
    supabase.from("live_account_snapshots").select("*").eq("account_id", "965848641").order("captured_at", { ascending: false }).limit(1).single(),
    supabase.from("briefings").select("*").order("created_at", { ascending: false }).limit(1).single(),
    supabase.from("strategy_config").select("trading_enabled, robinhood_mcp_enabled, autonomy_level, active_account_us").limit(1).maybeSingle(),
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
      mkt={mkt}
      tradingMandate={tradingMandate}
      livePolicy={strategyConfig ?? null}
    />
  );
}
