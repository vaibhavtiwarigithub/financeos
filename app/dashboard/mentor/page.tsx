import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import MentorPage from "@/components/dashboard/MentorPage";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) redirect("/login");

  const supabase = createServiceClient();

  const [
    { data: packets },
    { data: trades },
    { data: log },
    { data: signals },
  ] = await Promise.all([
    supabase
      .from("research_packets")
      .select("id, symbol, summary, key_risks, catalysts, fundamental_score, technical_score, sentiment_score, macro_score, insider_score, is_held_position, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("paper_trades")
      .select("id, symbol, order_side, qty, fill_price, exit_price, realized_pnl, pnl_pct, outcome, executed_at, closed_at, rationale, analyst_score")
      .order("executed_at", { ascending: false })
      .limit(30),
    supabase
      .from("learning_log")
      .select("id, note, trades_evaluated, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("agent_signals")
      .select("id, symbol, direction, analyst_score, rationale, status, conviction, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return (
    <MentorPage
      packets={packets ?? []}
      trades={trades ?? []}
      log={log ?? []}
      signals={signals ?? []}
    />
  );
}
