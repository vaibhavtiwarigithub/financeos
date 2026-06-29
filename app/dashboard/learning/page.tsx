import { createServiceClient } from "@/lib/supabase/service";
import LearningPage from "@/components/dashboard/LearningPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: fullLog },
    { data: performance },
    { data: weightsArr },
    { data: tradesArr },
  ] = await Promise.all([
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(50),
    supabase.from("paper_performance").select("date, nav, win_rate, total_trades").order("date", { ascending: true }).limit(90),
    supabase.from("signal_weights").select("*").limit(1),
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
      weights={weightsArr?.[0] ?? null}
      totalTrades={totalTrades}
      winRate={winRate}
    />
  );
}
