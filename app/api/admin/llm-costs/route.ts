import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireOwner } from "@/lib/auth/require-owner";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const gate = await requireOwner();
    if (gate) return gate;
    const svc = createServiceClient();

    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA");
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
    const monthAgo = new Date(now.getTime() - 30 * 86400000).toISOString();

    // Today's spend
    const { data: today } = await svc
      .from("llm_call_log")
      .select("cost_usd, tokens_in, tokens_out, model, task_type, created_at")
      .gte("created_at", new Date(todayStr).toISOString());

    // This week
    const { data: week } = await svc
      .from("llm_call_log")
      .select("cost_usd, tokens_in, tokens_out, model, created_at")
      .gte("created_at", weekAgo);

    // This month
    const { data: month } = await svc
      .from("llm_call_log")
      .select("cost_usd, model")
      .gte("created_at", monthAgo);

    // Per-model breakdown (month)
    const byModel: Record<string, { cost: number; calls: number }> = {};
    for (const row of month ?? []) {
      if (!byModel[row.model]) byModel[row.model] = { cost: 0, calls: 0 };
      byModel[row.model].cost += row.cost_usd ?? 0;
      byModel[row.model].calls++;
    }

    // Hourly spend today (for burn rate chart)
    const hourly: Record<number, number> = {};
    for (const row of today ?? []) {
      const h = new Date(row.created_at).getHours();
      hourly[h] = (hourly[h] ?? 0) + (row.cost_usd ?? 0);
    }
    const hourlyArr = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      cost: parseFloat((hourly[h] ?? 0).toFixed(4)),
    }));

    const todayCost = (today ?? []).reduce((s: number, r: any) => s + (r.cost_usd ?? 0), 0);
    const weekCost = (week ?? []).reduce((s: number, r: any) => s + (r.cost_usd ?? 0), 0);
    const monthCost = (month ?? []).reduce((s: number, r: any) => s + (r.cost_usd ?? 0), 0);

    // Burn rate: today's cost / hours elapsed
    const hoursElapsed = Math.max(1, now.getHours() + now.getMinutes() / 60);
    const burnRateHourly = todayCost / hoursElapsed;
    const projectedDaily = burnRateHourly * 24;

    // Alert thresholds
    const alerts: string[] = [];
    if (projectedDaily > 5)
      alerts.push(`Projected daily spend $${projectedDaily.toFixed(2)} — above $5 threshold`);
    if (weekCost > 20)
      alerts.push(`Weekly spend $${weekCost.toFixed(2)} — above $20 threshold`);

    return NextResponse.json({
      todayCost: parseFloat(todayCost.toFixed(4)),
      weekCost: parseFloat(weekCost.toFixed(2)),
      monthCost: parseFloat(monthCost.toFixed(2)),
      burnRateHourly: parseFloat(burnRateHourly.toFixed(4)),
      projectedDaily: parseFloat(projectedDaily.toFixed(2)),
      todayCalls: (today ?? []).length,
      weekCalls: (week ?? []).length,
      hourlyBreakdown: hourlyArr,
      byModel,
      alerts,
    });
  } catch (err) {
    console.error("[llm-costs] error:", err);
    return NextResponse.json({ error: "Failed to fetch LLM cost data" }, { status: 500 });
  }
}
