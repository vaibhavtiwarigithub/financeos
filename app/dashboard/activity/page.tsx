import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import ActivityPage from "@/components/dashboard/ActivityPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Server component — can't call useMarket() (client-only context). Reads the
  // `mkt` cookie MarketProvider keeps in sync, same pattern as the Home and
  // Agents pages. The feed was entirely unscoped before, so US and India events
  // interleaved in one $-denominated timeline.
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: runs },
    { data: signals },
    { data: trades },
    { data: log },
  ] = await Promise.all([
    // agent_runs.market defaults to 'us' for cross-market agents (learner, mentor,
    // macro-sentinel); a few pre-077 rows are null, so "us" also accepts null
    // rather than hiding them. Same idiom as the Agents page.
    market === "india"
      ? supabase.from("agent_runs").select("*").eq("market", "india").order("completed_at", { ascending: false }).limit(100)
      : supabase.from("agent_runs").select("*").or("market.eq.us,market.is.null").order("completed_at", { ascending: false }).limit(100),
    supabase.from("agent_signals").select("*").eq("market", market).order("created_at", { ascending: false }).limit(200),
    supabase.from("paper_trades").select("*").eq("market", market).order("executed_at", { ascending: false }).limit(100),
    // learning_log has NO market column — the LearnerAgent writes one global set
    // of notes across both books. Left unscoped deliberately; the UI labels these
    // events "all markets" so the feed doesn't imply they're ₹- or $-specific.
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(50),
  ]);

  return (
    <ActivityPage
      runs={runs ?? []}
      signals={signals ?? []}
      trades={trades ?? []}
      learningLog={log ?? []}
      market={market}
    />
  );
}
