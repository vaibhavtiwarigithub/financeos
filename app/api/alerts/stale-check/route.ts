import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// P0 improvement (learning-core spec 1b): a missed research/paper/monitor run
// isn't just an inconvenience anymore — it's a HOLE in the decision-observation
// ledger that biases every downstream label/validation. This checker enumerates
// every agent expected to have run TODAY (per market, per its own schedule) and
// raises a named, deduped alert for anything missing past its grace window.
//
// PC clock is assumed = ET (project convention — see scripts/register-tasks.ps1
// header notes on EST/EDT). India jobs are only checked when market_focus
// includes India (non-destructive gate — see Decision 31).

function fmtDateTime(d: Date): string {
  return d.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  });
}

interface ExpectedJob {
  agentType: string;         // agent_runs.agent_type value to check
  label: string;             // human label for the alert
  expectedHour: number;      // ET hour the job is scheduled at (24h)
  graceHours: number;        // how long after expectedHour before "missed"
  fridayOnly?: boolean;
  requiresIndia?: boolean;
  recoveryCmd: string;       // full manual-trigger command to show
}

const EXPECTED_JOBS: ExpectedJob[] = [
  { agentType: "research",         label: "Research (US)",           expectedHour: 9,  graceHours: 1,
    recoveryCmd: 'curl -X POST "https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/research/cron?market=us" -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "paper_trader",     label: "PaperTrader",              expectedHour: 9,  graceHours: 2,
    recoveryCmd: 'curl -X POST https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/paper-trade?market=us -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "position_monitor", label: "PositionMonitor (US)",     expectedHour: 16, graceHours: 2,
    recoveryCmd: 'curl -X POST "https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/position-monitor?market=us" -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "label_maturation", label: "Label maturation",         expectedHour: 18, graceHours: 2,
    recoveryCmd: 'curl -X POST https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/label-maturation -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "learner",          label: "LearnerAgent (weekly)",    expectedHour: 17, graceHours: 3, fridayOnly: true,
    recoveryCmd: 'curl -X POST https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/learner -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "research",         label: "Research (India)",         expectedHour: 7,  graceHours: 1, requiresIndia: true,
    recoveryCmd: 'curl -X POST "https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/research/cron?market=india" -H "x-cron-secret: YOUR_SECRET"' },
  { agentType: "position_monitor", label: "PositionMonitor (India)",  expectedHour: 8,  graceHours: 2, requiresIndia: true,
    recoveryCmd: 'curl -X POST "https://financeos-vaibhavtiwarigithubs-projects.vercel.app/api/agents/position-monitor?market=india" -H "x-cron-secret: YOUR_SECRET"' },
];

export async function GET() {
  const svc = createServiceClient();
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun .. 6=Sat
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isFriday = dayOfWeek === 5;
  const hour = now.getHours();

  if (!isWeekday) return NextResponse.json({ checked: false, reason: "weekend" });

  // India gate — resilient: any error/missing profile just skips India jobs.
  let indiaEnabled = false;
  try {
    const { data: profile } = await svc.from("profiles").select("market_focus").limit(1).maybeSingle();
    indiaEnabled = String((profile as any)?.market_focus ?? "").toLowerCase().includes("india");
  } catch { /* default false */ }

  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const results: any[] = [];

  for (const job of EXPECTED_JOBS) {
    if (job.fridayOnly && !isFriday) continue;
    if (job.requiresIndia && !indiaEnabled) continue;
    if (hour < job.expectedHour + job.graceHours) continue; // too early to judge yet

    // Distinguish US vs India research/monitor runs (agent_runs has no `market`
    // column pre-067 — infer from symbols like the research-cron idempotency
    // guard does; resiliently treats "can't tell" as a US-shaped run).
    const { data: todaysRuns } = await svc
      .from("agent_runs")
      .select("id, started_at, status, symbols, market, result_summary")
      .eq("agent_type", job.agentType)
      .gte("started_at", todayStart.toISOString())
      .order("started_at", { ascending: false })
      .limit(10);

    // Prefer the real `market` column (populated since migration 067). Only
    // fall back to symbol-sniffing for older rows that predate it — sniffing
    // alone misclassifies a "us" run whose symbol batch happens to include
    // held .NS/.BO tickers (e.g. India ETF proxies or cross-market holdings).
    const isIndiaRun = (r: any) =>
      Array.isArray(r?.symbols) && r.symbols.some((s: string) => /\.(NS|BO)$/i.test(String(s)));
    const matchesMarket = (r: any) => {
      if (r?.market === "us" || r?.market === "india") {
        return job.label.includes("India") ? r.market === "india" : r.market === "us";
      }
      return job.label.includes("India") ? isIndiaRun(r) : !isIndiaRun(r);
    };

    const ran = (todaysRuns ?? []).some(matchesMarket);
    results.push({ job: job.label, ran });
    if (ran) continue;

    // Missing — dedup on an open alert with the same job label for today.
    const alertTitle = `${job.label} missed — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`;
    const { data: existing } = await svc
      .from("agent_alerts")
      .select("id")
      .eq("category", "cron")
      .eq("title", alertTitle)
      .eq("resolved", false)
      .limit(1);
    if (existing?.length) continue;

    // Journal the gap (Phase 2's dataset builder can exclude flagged days).
    try {
      await svc.from("decision_journal").insert({
        entry_type: "cron_gap",
        summary: `${job.label} did not run today by ${job.expectedHour + job.graceHours}:00 (expected ~${job.expectedHour}:00 ET).`,
        resolved: false,
      });
    } catch { /* best-effort */ }

    const detail = [
      `Detected: ${fmtDateTime(now)}`,
      `Expected: ~${job.expectedHour}:00 ET${job.fridayOnly ? " (Fridays)" : " weekdays"}`,
      `Likely cause: the Supabase pg_cron job did not fire, or the endpoint errored/timed out. These run in the cloud (pg_cron -> Vercel) and do NOT need your PC on.`,
      `Recovery: ${job.recoveryCmd}`,
    ].join(" · ");

    await svc.from("agent_alerts").insert({
      severity: "warn",
      category: "cron",
      title: alertTitle,
      detail,
      auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
  }

  return NextResponse.json({ checked: true, hour, indiaEnabled, results });
}
