// Called on dashboard load — checks for missed cron runs and emits alerts if needed
import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const svc = createServiceClient();
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const hour = now.getHours();

  // Only check on weekdays after 10AM (1h grace after 9AM cron)
  if (!isWeekday || hour < 10) return NextResponse.json({ checked: false });

  // Last research run
  const { data: lastRun } = await svc
    .from("agent_runs")
    .select("created_at, status")
    .eq("agent_type", "research")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  const lastRunAt = lastRun ? new Date(lastRun.created_at) : null;
  const hoursSinceLast = lastRunAt ? (now.getTime() - lastRunAt.getTime()) / 3600000 : 999;

  // No run today (>14h ago on weekday after 10AM = missed cron)
  if (hoursSinceLast > 14) {
    // Check if we already have an unresolved alert for this
    const { data: existing } = await svc
      .from("agent_alerts")
      .select("id")
      .eq("category", "cron")
      .eq("title", "Research cron missed")
      .eq("resolved", false)
      .limit(1);

    if (!existing?.length) {
      await svc.from("agent_alerts").insert({
        severity: "warn",
        category: "cron",
        title: "Research cron missed",
        detail: lastRunAt
          ? `Last run: ${lastRunAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}. App may not be running at 9AM.`
          : "No research runs found. Trigger manually: POST /api/agents/research/cron",
        auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      });
    }
  }

  return NextResponse.json({ checked: true, hoursSinceLast: Math.round(hoursSinceLast) });
}
