import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CapitalShell from "@/components/capital/CapitalShell";

export default async function CapitalPlanLayout({ children }: { children: React.ReactNode }) {
  const client = await createClient();
  const { data: { session } } = await client.auth.getSession();
  if (!session) redirect("/login");
  return <CapitalShell>{children}</CapitalShell>;
}
