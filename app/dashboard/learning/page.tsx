import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveDisplayWeights } from "@/lib/champion-weights";
import LearningPage from "@/components/dashboard/LearningPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Per-market champion weights (NOT the vestigial global signal_weights row).
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: fullLog },
    { data: performance },
    weights,
    { data: tradesArr },
  ] = await Promise.all([
    // learning_log has NO market column — it is legitimately global. Left unscoped.
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(50),
    // Scoped: NAV is a currency amount. Unscoped, the equity curve interleaved
    // USD and INR NAV points into one series.
    supabase.from("paper_performance").select("date, nav, win_rate, total_trades").eq("market", market).order("date", { ascending: true }).limit(90),
    resolveDisplayWeights(supabase, market),
    // Scoped: win rate must describe one book, not a blend of both.
    supabase.from("paper_trades").select("outcome").eq("market", market).not("outcome", "is", null),
  ]);

  const trades = tradesArr ?? [];
  const totalTrades = trades.length;
  const wins = trades.filter((t: any) => t.outcome === "win").length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

  return (
    <LearningPage
      learningLog={[]}
      fullLog={fullLog ?? []}
      performance={performance ?? []}
      weights={weights}
      totalTrades={totalTrades}
      winRate={winRate}
      market={market}
    />
  );
}
