import { createClient } from "@/lib/supabase/server";
import DashboardHome from "@/components/dashboard/DashboardHome";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const [{ data: profile }, { data: holdings }, { data: predictions }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user!.id).single(),
    supabase.from("holdings").select("*").eq("user_id", user!.id),
    supabase.from("predictions").select("*").eq("user_id", user!.id).eq("status", "open").limit(3),
  ]);

  return <DashboardHome profile={profile} holdings={holdings ?? []} predictions={predictions ?? []} />;
}
