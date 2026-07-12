import { redirect } from "next/navigation";

export default function AgentHistoryRedirect() {
  redirect("/dashboard/agents?tab=history");
}
