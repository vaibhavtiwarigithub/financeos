import { createServiceClient } from "@/lib/supabase/service";
import ActivityPage from "@/components/dashboard/ActivityPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = createServiceClient();

  const [
    { data: runs },
    { data: signals },
    { data: trades },
    { data: log },
  ] = await Promise.all([
    supabase.from("agent_runs").select("*").order("completed_at", { ascending: false }).limit(100),
    supabase.from("agent_signals").select("*").order("created_at", { ascending: false }).limit(200),
    supabase.from("paper_trades").select("*").order("executed_at", { ascending: false }).limit(100),
    supabase.from("learning_log").select("*").order("created_at", { ascending: false }).limit(50),
  ]);

  return (
    <ActivityPage
      runs={runs ?? []}
      signals={signals ?? []}
      trades={trades ?? []}
      learningLog={log ?? []}
    />
  );
}
