import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import YouPage from "@/components/dashboard/YouPage";

export const dynamic = "force-dynamic";

export default async function Page() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [
    { data: profile },
    { data: predictions },
    { data: journal },
    { data: quizHistory },
  ] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", user.id).single(),
    supabase.from("predictions").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
    supabase.from("journal_entries").select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10),
    supabase.from("quiz_history").select("*").eq("user_id", user.id).order("completed_at", { ascending: false }).limit(5),
  ]);

  return (
    <YouPage
      profile={profile}
      predictions={predictions ?? []}
      journal={journal ?? []}
      quizHistory={quizHistory ?? []}
    />
  );
}
