import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PropertyShell from "@/components/property/PropertyShell";

export default async function PropertyLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");
  return <PropertyShell>{children}</PropertyShell>;
}
