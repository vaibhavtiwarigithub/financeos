import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

function fmtDateTime(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

function fmtRelative(ms: number): string {
  const h = Math.round(ms / 3600000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

export async function GET() {
  const svc = createServiceClient();
  const now = new Date();
  const dayOfWeek = now.getDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const hour = now.getHours();

  if (!isWeekday || hour < 10) return NextResponse.json({ checked: false });

  const { data: lastRun } = await svc
    .from("agent_runs")
    .select("created_at, status, signals_written, result_summary")
    .eq("agent_type", "research")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  const lastRunAt = lastRun ? new Date(lastRun.created_at) : null;
  const msSinceLast = lastRunAt ? now.getTime() - lastRunAt.getTime() : Infinity;
  const hoursSinceLast = msSinceLast / 3600000;

  if (hoursSinceLast > 14) {
    const { data: existing } = await svc
      .from("agent_alerts")
      .select("id")
      .eq("category", "cron")
      .ilike("title", "Research cron missed%")
      .eq("resolved", false)
      .limit(1);

    if (!existing?.length) {
      const detectedAt = fmtDateTime(now);
      const expectedTime = "9:00 AM ET weekdays";

      let detail: string;
      if (lastRunAt) {
        const lastStr = fmtDateTime(lastRunAt);
        const rel = fmtRelative(msSinceLast);
        const signals = lastRun?.signals_written ?? "?";
        detail = [
          `Detected: ${detectedAt}`,
          `Expected: ${expectedTime}`,
          `Last run: ${lastStr} (${rel}) — ${signals} signals produced`,
          `Likely cause: App server was not running at 9 AM. Open terminal → start dev server → it will auto-run next weekday at 9 AM.`,
          `Manual trigger: POST /api/agents/research/cron with x-cron-secret header`,
        ].join(" · ");
      } else {
        detail = [
          `Detected: ${detectedAt}`,
          `Expected: ${expectedTime}`,
          `No runs ever found. Research agent has never run on this instance.`,
          `Manual trigger: POST /api/agents/research/cron with x-cron-secret header`,
          `Or run in dev: curl -X POST http://localhost:3000/api/agents/research/cron -H "x-cron-secret: YOUR_SECRET"`,
        ].join(" · ");
      }

      await svc.from("agent_alerts").insert({
        severity: "warn",
        category: "cron",
        title: `Research cron missed — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`,
        detail,
        auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      });
    }
  }

  return NextResponse.json({
    checked: true,
    hoursSinceLast: Math.round(hoursSinceLast),
    lastRunAt: lastRunAt?.toISOString() ?? null,
  });
}
