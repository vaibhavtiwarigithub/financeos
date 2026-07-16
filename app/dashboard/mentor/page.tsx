import { cookies } from "next/headers";
import { createServiceClient } from "@/lib/supabase/service";
import { resolveDisplayWeights } from "@/lib/champion-weights";
import MentorPage from "@/components/dashboard/MentorPage";

export const revalidate = 30;

export default async function Page() {
  const supabase = createServiceClient();

  // Read the `mkt` cookie MarketProvider keeps in sync so weights are the
  // per-market champion's, not a shared global blob (same pattern as Agents).
  const cookieStore = await cookies();
  const market = cookieStore.get("mkt")?.value === "india" ? "india" : "us";

  const [
    { data: packets },
    { data: trades },
    { data: fullLog },
    { data: signals },
    { data: performance },
    weights,
    { data: allTradesArr },
  ] = await Promise.all([
    // research_packets has NO market column — legitimately global. Left unscoped.
    supabase
      .from("research_packets")
      .select("id, symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, is_held_position, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    // Scoped: trades carry $ / ₹ fills and P&L — never mix the two books.
    supabase
      .from("paper_trades")
      .select("id, symbol, order_side, qty, fill_price, exit_price, realized_pnl, pnl_pct, outcome, executed_at, closed_at, rationale, analyst_score")
      .eq("market", market)
      .order("executed_at", { ascending: false })
      .limit(30),
    // learning_log has NO market column — legitimately global. Left unscoped.
    supabase
      .from("learning_log")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50),
    // Scoped: a US signal must not surface on the India tab.
    supabase
      .from("agent_signals")
      .select("id, symbol, direction, analyst_score, rationale, status, conviction, created_at")
      .eq("market", market)
      .order("created_at", { ascending: false })
      .limit(20),
    // Scoped: NAV is a currency amount — one book per equity curve.
    supabase.from("paper_performance").select("date, nav, win_rate, total_trades").eq("market", market).order("date", { ascending: true }).limit(90),
    // Per-market champion weights (NOT the vestigial global signal_weights row).
    resolveDisplayWeights(supabase, market),
    // Scoped: win rate must describe one book, not a blend of both.
    supabase.from("paper_trades").select("outcome").eq("market", market).not("outcome", "is", null),
  ]);

  const allTrades = allTradesArr ?? [];

  return (
    <MentorPage
      packets={packets ?? []}
      trades={trades ?? []}
      fullLog={fullLog ?? []}
      signals={signals ?? []}
      performance={performance ?? []}
      weights={weights}
      allTrades={allTrades}
      market={market}
    />
  );
}
