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

  // Admin is already verified above. profiles RLS is "auth.uid() = id" (every
  // user, including an admin, can only see their OWN row) — so the "all users"
  // list and counts were silently scoped to just the caller. Use the service
  // client for these admin-gated reads, same pattern as everywhere else.
  const svc = createServiceClient();

  const { searchParams } = new URL(req.url);
  const action = searchParams.get("action");

  if (action === "users") {
    // subscription_status doesn't exist on profiles (no billing subsystem is
    // wired up yet) — selecting it 400'd every call, and the error was
    // silently swallowed (only `data` was destructured), so this always
    // returned users: null with no visible error.
    const { data, error } = await svc
      .from("profiles")
      .select("id, email, full_name, role, subscription_tier, xp, analysis_count, created_at")
      .order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ users: data });
  }

  if (action === "stats") {
    const { count: totalUsers } = await svc.from("profiles").select("*", { count: "exact", head: true });
    const { count: proUsers } = await svc.from("profiles").select("*", { count: "exact", head: true }).eq("subscription_tier", "pro");
    const { count: eliteUsers } = await svc.from("profiles").select("*", { count: "exact", head: true }).eq("subscription_tier", "elite");
    // usage_logs is a dead/legacy table nothing writes to — real cost lives in
    // llm_call_log (see /dashboard/admin/llm-history).
    const { data: recentUsage } = await svc.from("llm_call_log").select("cost_usd").gte("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
    const totalCost = recentUsage?.reduce((s: number, r: any) => s + (Number(r.cost_usd) || 0), 0) ?? 0;
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

  // profiles RLS ("auth.uid() = id") would silently filter this UPDATE to zero
  // rows for any user other than the admin themselves (RLS filters, doesn't
  // error) — an admin could never actually change someone else's role/tier.
  // Admin is already verified above; use the service client for the write.
  const svc = createServiceClient();
  const { error, count } = await svc.from("profiles").update(update).eq("id", userId).select("id", { count: "exact" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!count) return NextResponse.json({ error: "No matching user" }, { status: 404 });

  return NextResponse.json({ success: true });
}
