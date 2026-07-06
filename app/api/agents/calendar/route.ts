import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Agents expected every weekday (all currently scheduled via pg_cron — see
// PROJECT_DECISIONS Decision 38 area / kairos_pg_cron_vercel_schedule migration).
const DAILY_AGENTS = ["research", "paper_trader", "position-monitor", "research-india", "position-monitor-india"];
const FRIDAY_ONLY_AGENTS = ["learner"];

type CellStatus = "ok" | "error" | "partial" | "skipped" | "missing";
interface Cell { status: CellStatus; runs: number; summary: string; trigger: string | null }

function classifyRuns(runs: any[]): CellStatus {
  if (runs.length === 0) return "missing";
  const summaries = runs.map(r => String(r.result_summary ?? ""));
  if (summaries.some(s => /skipped|weekend|holiday/i.test(s))) return "skipped";
  const errored = runs.filter(r => r.status === "error" || /^error/i.test(String(r.result_summary ?? "")));
  if (errored.length === runs.length) return "error";
  if (errored.length > 0) return "partial";
  return "ok";
}

export async function GET() {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const svc = createServiceClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: runs } = await svc
    .from("agent_runs")
    .select("agent_type, status, started_at, completed_at, result_summary, trigger_source")
    .gte("started_at", since)
    .order("started_at", { ascending: false });

  const byDateAgent = new Map<string, any[]>();
  for (const r of (runs ?? []) as any[]) {
    const date = String(r.started_at).slice(0, 10);
    const key = `${date}|${r.agent_type}`;
    if (!byDateAgent.has(key)) byDateAgent.set(key, []);
    byDateAgent.get(key)!.push(r);
  }

  const days: { date: string; agents: Record<string, Cell> }[] = [];
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getDay(); // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6;
    const expected = isWeekend ? [] : [...DAILY_AGENTS, ...(dow === 5 ? FRIDAY_ONLY_AGENTS : [])];

    // Union of expected agents + any agent that actually ran that day (covers ad-hoc/manual runs).
    const ranAgents = new Set<string>();
    for (const key of byDateAgent.keys()) {
      const [date, agent] = key.split("|");
      if (date === dateStr) ranAgents.add(agent);
    }
    const agentSet = new Set([...expected, ...ranAgents]);

    const agents: Record<string, Cell> = {};
    for (const agent of agentSet) {
      const runsForCell = byDateAgent.get(`${dateStr}|${agent}`) ?? [];
      let status = classifyRuns(runsForCell);
      if (status === "missing" && isWeekend) continue; // weekends aren't "missing", just absent
      if (status === "missing" && !expected.includes(agent)) continue; // only flag missing for expected agents
      const last = runsForCell[0];
      agents[agent] = {
        status,
        runs: runsForCell.length,
        summary: status === "missing"
          ? "No run recorded — PC off/asleep at trigger time, or Vercel cron not yet configured for this agent. See scripts/README recovery."
          : String(last?.result_summary ?? "").slice(0, 200),
        trigger: last?.trigger_source ?? null,
      };
    }
    days.push({ date: dateStr, agents });
  }

  return NextResponse.json({ days });
}
