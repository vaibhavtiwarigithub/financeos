import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import DashboardHome from "@/components/dashboard/DashboardHome";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  const supabase = createServiceClient();

  const [
    { data: profile },
    { data: holdings },
    { data: predictions },
    { data: signals },
    { data: paperPortfolioArr },
  ] = await Promise.all([
    userClient.from("profiles").select("*").eq("id", user!.id).single(),
    userClient.from("holdings").select("*").eq("user_id", user!.id),
    userClient.from("predictions").select("*").eq("user_id", user!.id).eq("status", "open").limit(3),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(5),
    supabase.from("paper_portfolio").select("*").limit(1),
  ]);

  return (
    <DashboardHome
      profile={profile}
      holdings={holdings ?? []}
      predictions={predictions ?? []}
      signals={signals ?? []}
      paperPortfolio={paperPortfolioArr?.[0] ?? null}
    />
  );
}
