import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Agents expected every weekday. These MUST be the agent_runs.agent_type values
// (underscore, no market suffix) — agent_runs does not split market in agent_type
// (the `market` column does), so US + India runs of the same agent share one row.
// Using the old dash / -india names caused a permanent false "missing" row next
// to the real underscore row (the calendar double-row bug).
const DAILY_AGENTS = ["research", "paper_trader", "position_monitor"];
const FRIDAY_ONLY_AGENTS = ["learner"];
// Collapse any legacy dash spelling into the canonical underscore agent_type.
const canon = (a: string) => a.replace(/-/g, "_");

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

export async function GET(req: NextRequest) {
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // ?market=us|india scopes the grid to that market's runs (follows the header
  // switch), so the calendar shows whether the US pipeline OR the India pipeline
  // ran. India = market 'india'; US view also includes cross-market/global agents
  // (learner, mentor) that run once with market 'us' or null.
  const market = req.nextUrl.searchParams.get("market") === "india" ? "india" : "us";

  const svc = createServiceClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: rawRuns } = await svc
    .from("agent_runs")
    .select("agent_type, status, started_at, completed_at, result_summary, trigger_source, market")
    .gte("started_at", since)
    .order("started_at", { ascending: false });

  const runs = (rawRuns ?? []).filter((r: any) =>
    market === "india" ? r.market === "india" : (r.market == null || r.market === "us"),
  );

  const byDateAgent = new Map<string, any[]>();
  for (const r of runs as any[]) {
    const date = String(r.started_at).slice(0, 10);
    const key = `${date}|${canon(String(r.agent_type ?? ""))}`;
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
          ? "No run recorded. These run in the cloud (Supabase pg_cron → Vercel) and don't need your PC on — a gap means the cron didn't fire or the endpoint errored/timed out. Re-run from the app or check Supabase pg_cron logs."
          : String(last?.result_summary ?? "").slice(0, 200),
        trigger: last?.trigger_source ?? null,
      };
    }
    days.push({ date: dateStr, agents });
  }

  return NextResponse.json({ days, market });
}
