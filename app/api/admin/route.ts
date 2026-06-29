import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

async function requireAdmin(supabase: Awaited<ReturnType<typeof createClient>>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "superadmin"].includes(profile.role)) return null;
  return user;
}

export async function GET(req: NextRequest) {
  const supabase = await createClient();
  const admin = await requireAdmin(supabase);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "users") {
    const { data } = await supabase
      .from("profiles")
      .select("id, email, full_name, role, subscription_tier, subscription_status, xp, analysis_count, created_at")
      .order("created_at", { ascending: false });
    return NextResponse.json({ users: data });
  }

  if (action === "stats") {
    const { count: totalUsers } = await supabase.from("profiles").select("*", { count: "exact", head: true });
    const { count: proUsers } = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("subscription_tier", "pro");
    const { count: eliteUsers } = await supabase.from("profiles").select("*", { count: "exact", head: true }).eq("subscription_tier", "elite");
    const { data: recentUsage } = await supabase.from("usage_logs").select("cost_usd").gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    const totalCost = recentUsage?.reduce((s, r) => s + (r.cost_usd ?? 0), 0) ?? 0;
    return NextResponse.json({ totalUsers, proUsers, eliteUsers, totalCost });
  }

  if (action === "token_usage") {
    const svc = createServiceClient();
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: runs } = await svc
      .from("agent_runs")
      .select("agent_type, tokens_input, tokens_output, claude_calls, completed_at")
      .gte("completed_at", since)
      .not("tokens_input", "is", null)
      .order("completed_at", { ascending: true });

    // Group by date
    const byDate: Record<string, { date: string; input: number; output: number; calls: number; runs: number }> = {};
    for (const r of runs ?? []) {
      const date = r.completed_at?.slice(0, 10) ?? "unknown";
      if (!byDate[date]) byDate[date] = { date, input: 0, output: 0, calls: 0, runs: 0 };
      byDate[date].input += r.tokens_input ?? 0;
      byDate[date].output += r.tokens_output ?? 0;
      byDate[date].calls += r.claude_calls ?? 0;
      byDate[date].runs++;
    }
    return NextResponse.json({ days: Object.values(byDate), runs: runs ?? [] });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const admin = await requireAdmin(supabase);
  if (!admin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { userId, role, tier } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

  const update: Record<string, string> = {};
  if (role) update.role = role;
  if (tier) update.subscription_tier = tier;

  const { error } = await supabase.from("profiles").update(update).eq("id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ success: true });
}
