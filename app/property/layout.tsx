import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import PropertyShell from "@/components/property/PropertyShell";
import { PropertyMarketProvider } from "@/lib/property/market-context";

export default async function PropertyLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");
  return <PropertyMarketProvider><PropertyShell>{children}</PropertyShell></PropertyMarketProvider>;
}
