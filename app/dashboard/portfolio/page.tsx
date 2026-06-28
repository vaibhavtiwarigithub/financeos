import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import PortfolioPage from "@/components/dashboard/PortfolioPage";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function Page() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) redirect("/login");

  const supabase = createServiceClient();

  const [
    { data: portfolioArr },
    { data: positions },
    { data: trades },
    { data: perf },
    { data: signals },
  ] = await Promise.all([
    supabase.from("paper_portfolio").select("*").limit(1),
    supabase.from("paper_positions").select("*").order("opened_at", { ascending: false }),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(50),
    supabase.from("paper_performance").select("*").order("date", { ascending: true }).limit(60),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(20),
  ]);

  return (
    <PortfolioPage
      portfolio={portfolioArr?.[0] ?? null}
      positions={positions ?? []}
      trades={trades ?? []}
      perf={perf ?? []}
      signals={signals ?? []}
    />
  );
}
