import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const days = Math.min(parseInt(req.nextUrl.searchParams.get("days") ?? "14"), 30);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const svc = createServiceClient();
  const { data: runs } = await svc
    .from("agent_runs")
    .select("id, agent_type, status, started_at, completed_at, tokens_input, tokens_output, claude_calls, signals_written")
    .gte("started_at", cutoff)
    .order("started_at", { ascending: true });

  if (!runs || runs.length === 0) {
    return NextResponse.json({
      runs: [],
      hourly: [],
      daily: [],
      summary: { totalRuns: 0, totalClaudeCalls: 0, totalTokensIn: 0, totalTokensOut: 0, totalTokens: 0 },
    });
  }

  // Hourly buckets
  const hourlyMap: Record<string, { hour: string; label: string; runs: number; tokensIn: number; tokensOut: number; claudeCalls: number }> = {};
  // Daily buckets
  const dailyMap: Record<string, { date: string; runs: number; tokensIn: number; tokensOut: number; claudeCalls: number; byAgent: Record<string, number> }> = {};

  for (const run of runs) {
    const dt = new Date(run.started_at);
    const hourKey = dt.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const dateKey = run.started_at.slice(0, 10);
    const hour = `${dateKey} ${hourKey.slice(11)}:00`;

    if (!hourlyMap[hourKey]) {
      hourlyMap[hourKey] = { hour, label: hour, runs: 0, tokensIn: 0, tokensOut: 0, claudeCalls: 0 };
    }
    hourlyMap[hourKey].runs += 1;
    hourlyMap[hourKey].tokensIn += run.tokens_input ?? 0;
    hourlyMap[hourKey].tokensOut += run.tokens_output ?? 0;
    hourlyMap[hourKey].claudeCalls += run.claude_calls ?? 0;

    if (!dailyMap[dateKey]) {
      dailyMap[dateKey] = { date: dateKey, runs: 0, tokensIn: 0, tokensOut: 0, claudeCalls: 0, byAgent: {} };
    }
    dailyMap[dateKey].runs += 1;
    dailyMap[dateKey].tokensIn += run.tokens_input ?? 0;
    dailyMap[dateKey].tokensOut += run.tokens_output ?? 0;
    dailyMap[dateKey].claudeCalls += run.claude_calls ?? 0;
    dailyMap[dateKey].byAgent[run.agent_type] = (dailyMap[dateKey].byAgent[run.agent_type] ?? 0) + 1;
  }

  const totalTokensIn = runs.reduce((a: number, r: any) => a + (r.tokens_input ?? 0), 0);
  const totalTokensOut = runs.reduce((a: number, r: any) => a + (r.tokens_output ?? 0), 0);
  const totalClaudeCalls = runs.reduce((a: number, r: any) => a + (r.claude_calls ?? 0), 0);

  return NextResponse.json({
    runs,
    hourly: Object.values(hourlyMap),
    daily: Object.values(dailyMap),
    summary: {
      totalRuns: runs.length,
      totalClaudeCalls,
      totalTokensIn,
      totalTokensOut,
      totalTokens: totalTokensIn + totalTokensOut,
    },
  });
}
