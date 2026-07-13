import { redirect } from "next/navigation";

export default function ScoresRedirect() {
  redirect("/dashboard/research-journal?tab=scores");
}
