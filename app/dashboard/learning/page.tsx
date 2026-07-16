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
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("paper_performance").select("date, nav, win_rate, total_trades").order("date", { ascending: true }).limit(90),
    resolveDisplayWeights(supabase, market),
    supabase.from("paper_trades").select("outcome").not("outcome", "is", null),
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
    />
  );
}
