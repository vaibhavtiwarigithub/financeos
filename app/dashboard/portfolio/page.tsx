import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import PortfolioPage from "@/components/dashboard/PortfolioPage";
import { loadPaperExitPlans } from "@/lib/trading/load-paper-exit-plans";
import { loadInternationalAllocationPolicy } from "@/lib/allocation/international-policy";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Every market-tagged query below MUST be scoped server-side.
  //
  // These used to fetch unscoped and let the client filter by market. With a
  // shared row cap that silently truncates whichever book has fewer recent rows:
  // the 50 newest paper_trades across both books were 29 India + 21 US, and only
  // 1 of those 21 US rows was closed — so the header rendered "0% win rate,
  // 0W / 1L" while the US book actually had 8 closed trades (1W/5L/2 breakeven).
  // India was equally wrong (5 closed in-slice vs 20 in reality). Same trap for
  // the NAV sparkline (60 rows split across two books) and the signals tab.
  //
  // Server component — can't call useMarket(); reads the `mkt` cookie that
  // MarketProvider keeps in sync and router.refresh()es on switch. Same pattern
  // as the Activity, Agents, and Home pages.
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: pools },
    { data: positions },
    { data: trades },
    { data: perf },
    { data: signals },
    { data: pendingSignals },
    { data: strategyArr },
    { data: tradeQueueArr },
    { count: winCount },
    { count: lossCount },
    { count: breakevenCount },
  ] = await Promise.all([
    // Phase 4: fetch ALL pools (US + India ₹ post-057). The client component
    // filters by selected market and shows each in its own currency — never blended.
    // Pre-057 (no market column) this returns the single US row unchanged.
    supabase.from("paper_portfolio").select("*"),
    supabase.from("paper_positions").select("*").eq("market", market).order("opened_at", { ascending: false }),
    supabase.from("paper_trades").select("*").eq("market", market).order("executed_at", { ascending: false }).limit(50),
    supabase.from("paper_performance").select("*").eq("market", market).order("date", { ascending: true }).limit(60),
    supabase.from("agent_signals").select("*").eq("market", market).order("created_at", { ascending: false }).limit(20),
    supabase.from("agent_signals").select("*, research_packets(*)").eq("market", market).eq("status", "pending").order("created_at", { ascending: false }).limit(20),
    supabase.from("strategy_config").select("*").limit(1),
    // Trade queue is Robinhood-US only (the client blanks it under the India
    // view), so it is pinned to the US book rather than the selected market —
    // unscoped, it leaked India signals into the US queue.
    supabase.from("agent_signals").select("id, symbol, direction, analyst_score, conviction, rationale, created_at").eq("market", "us").eq("status", "pending").gte("analyst_score", 60).order("analyst_score", { ascending: false }).limit(20),
    // Win rate is a whole-book statistic, so it must NOT be derived from the
    // 50-row trades slice above. Exact head counts avoid both display truncation
    // and PostgREST's row-return ceiling; unknown outcomes are not breakevens.
    supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("market", market).eq("outcome", "win"),
    supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("market", market).eq("outcome", "loss"),
    supabase.from("paper_trades").select("*", { count: "exact", head: true }).eq("market", market).eq("outcome", "breakeven"),
  ]);

  const [exitPlans, internationalAllocationPolicy] = await Promise.all([
    loadPaperExitPlans(supabase, positions ?? []),
    loadInternationalAllocationPolicy(supabase),
  ]);

  return (
    <PortfolioPage
      pools={pools ?? []}
      dataMarket={market}
      positions={positions ?? []}
      trades={trades ?? []}
      perf={perf ?? []}
      signals={signals ?? []}
      pendingSignals={pendingSignals ?? []}
      tradeRecord={{
        wins: winCount ?? 0,
        losses: lossCount ?? 0,
        breakeven: breakevenCount ?? 0,
        closed: (winCount ?? 0) + (lossCount ?? 0) + (breakevenCount ?? 0),
      }}
      strategy={strategyArr?.[0] ?? null}
      tradeQueue={tradeQueueArr ?? []}
      exitPlans={exitPlans}
      internationalAllocationPolicy={internationalAllocationPolicy}
    />
  );
}
