import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirect } from "next/navigation";
import YouPage from "@/components/dashboard/YouPage";

export const revalidate = 30;

export default async function Page() {
  const authClient = await createClient();
  const { data: { session } } = await authClient.auth.getSession();
  if (!session) redirect("/login");

  const supabase = createServiceClient();
  const { data: profile } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();

  return (
    <YouPage
      profile={profile}
      predictions={[]}
      journal={[]}
      quizHistory={[]}
    />
  );
}
