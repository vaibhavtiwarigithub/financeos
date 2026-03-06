// Portfolio page - loads from DB
import { createClient } from "@/lib/supabase/server";

export default async function PortfolioPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const { data: holdings } = await supabase.from("holdings").select("*").eq("user_id", user!.id);
  const { data: profile } = await supabase.from("profiles").select("subscription_tier").eq("id", user!.id).single();

  return (
    <div style={{ padding: "28px", fontFamily: "'Inter', sans-serif", color: "#ECEDEF" }}>
      <div style={{ fontSize: "20px", fontWeight: 600, marginBottom: "8px" }}>Portfolio</div>
      <div style={{ fontSize: "13px", color: "#6B7280", marginBottom: "24px" }}>
        {holdings?.length ?? 0} positions tracked &middot; Tier: {profile?.subscription_tier}
      </div>
      <div style={{ background: "#1A1D27", border: "1px solid #252836", borderRadius: "12px", padding: "24px", textAlign: "center", color: "#6B7280" }}>
        Full portfolio management UI coming — holdings, charts, stress test, position sizer
      </div>
    </div>
  );
}
