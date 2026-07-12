import { redirect } from "next/navigation";

// Smart Money merged into the Intelligence page as a tab (one "Signals"
// surface). This route now redirects to the Intelligence Smart Money tab.
export default function SmartMoneyRedirect() {
  redirect("/dashboard/intelligence?tab=smart-money");
}
