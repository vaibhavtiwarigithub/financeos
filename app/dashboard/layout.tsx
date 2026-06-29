import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DashboardShell from "@/components/dashboard/DashboardShell";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // getSession() reads cookie — no network call. Middleware already validated the JWT.
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const svc = (await import("@/lib/supabase/service")).createServiceClient();
  const { data: profile } = await svc
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (!profile) redirect("/login");

  const { data: config } = await svc.from("strategy_config").select("app_paused, paused_reason").limit(1).single();
  const appPaused = (config as any)?.app_paused ?? false;
  const pausedReason = (config as any)?.paused_reason ?? null;

  return <DashboardShell profile={profile} appPaused={appPaused} pausedReason={pausedReason}>{children}</DashboardShell>;
}
