import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createClient } from "@/lib/supabase/server";
import { verifyCronSecret } from "@/lib/auth/cron";

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
  expectedHour: number;      // UTC hour from the actual pg_cron schedule
  graceHours: number;        // how long after expectedHour before "missed"
  fridayOnly?: boolean;
  requiresIndia?: boolean;
  recoveryCmd: string;       // full manual-trigger command to show
}

const EXPECTED_JOBS: ExpectedJob[] = [
  { agentType: "research", label: "Research (US)", expectedHour: 13, graceHours: 1,
    recoveryCmd: 'POST /api/agents/research/cron?market=us' },
  { agentType: "paper_trader", label: "PaperTrader (US)", expectedHour: 14, graceHours: 2,
    recoveryCmd: 'POST /api/agents/paper-trade?market=us' },
  { agentType: "position_monitor", label: "PositionMonitor (US)", expectedHour: 20, graceHours: 2,
    recoveryCmd: 'POST /api/agents/position-monitor?market=us' },
  { agentType: "label_maturation", label: "Label maturation", expectedHour: 22, graceHours: 2,
    recoveryCmd: 'POST /api/agents/label-maturation' },
  { agentType: "learner", label: "LearnerAgent (US weekly)", expectedHour: 21, graceHours: 2, fridayOnly: true,
    recoveryCmd: 'POST /api/agents/learner with {"market":"us"}' },
  { agentType: "validation_sweep", label: "Validation sweep (weekly)", expectedHour: 21, graceHours: 2, fridayOnly: true,
    recoveryCmd: 'POST /api/validation/sweep' },
  { agentType: "research", label: "Research (India)", expectedHour: 4, graceHours: 1, requiresIndia: true,
    recoveryCmd: 'POST /api/agents/research/cron?market=india' },
  { agentType: "paper_trader", label: "PaperTrader (India)", expectedHour: 11, graceHours: 2, requiresIndia: true,
    recoveryCmd: 'POST /api/agents/paper-trade?market=india' },
  { agentType: "position_monitor", label: "PositionMonitor (India)", expectedHour: 11, graceHours: 2, requiresIndia: true,
    recoveryCmd: 'POST /api/agents/position-monitor?market=india' },
  { agentType: "learner", label: "LearnerAgent (India weekly)", expectedHour: 20, graceHours: 2, fridayOnly: true, requiresIndia: true,
    recoveryCmd: 'POST /api/agents/learner with {"market":"india"}' },
];

// Convert a UTC Date to ET (America/New_York) wall-clock parts for schedule comparisons.
// Vercel runs in UTC; all expectedHour values are ET — this is the single conversion point.
function toET(d: Date): { hour: number; day: number; dateStr: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", hour12: false,
    weekday: "narrow",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  // hour12:false returns 0–23 but formatToParts may give "24" at midnight; normalise.
  const hour = parseInt(get("hour"), 10) % 24;
  const weekdayMap: Record<string, number> = { S: 0, M: 1, T: 2, W: 3, F: 5 };
  // narrow weekday: S=Sun, M=Mon, T=Tue/Thu, W=Wed, F=Fri — Thu colides with Tue.
  // Use day-of-week from getUTCDay adjusted by ET offset instead.
  const utcDay = d.getUTCDay();
  // ET offset: Mar–Nov EDT UTC-4, else EST UTC-5 (approximate by month)
  const utcMonth = d.getUTCMonth(); // 0-indexed
  const etOffsetHours = utcMonth >= 2 && utcMonth <= 10 ? -4 : -5;
  // Build a Date at ET midnight to derive the correct weekday
  const etMidnightUTC = new Date(d.getTime() + etOffsetHours * 3600_000);
  etMidnightUTC.setUTCHours(0, 0, 0, 0);
  const etDay = etMidnightUTC.getUTCDay();
  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  return { hour, day: etDay, dateStr };
}

async function isAuthorized(req: NextRequest): Promise<boolean> {
  if (verifyCronSecret(req)) return true;
  const userClient = await createClient();
  const { data: { user } } = await userClient.auth.getUser();
  return Boolean(user);
}

async function runCheck() {
  const svc = createServiceClient();
  const now = new Date();
  // Compare against the actual pg_cron schedule, which is expressed in UTC.
  // This avoids DST approximations and false alerts around transition weeks.
  const dayOfWeek = now.getUTCDay();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isFriday = dayOfWeek === 5;
  const hour = now.getUTCHours();

  if (!isWeekday) return NextResponse.json({ checked: false, reason: "weekend" });

  // India gate — resilient: any error/missing profile just skips India jobs.
  let indiaEnabled = false;
  try {
    const { data: profile } = await svc.from("profiles").select("market_focus").limit(1).maybeSingle();
    indiaEnabled = String((profile as any)?.market_focus ?? "").toLowerCase().includes("india");
  } catch { /* default false */ }

  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const dateStr = todayStart.toISOString().slice(0, 10);
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
    // issue_key includes ET date so two consecutive missed days get separate keys
    // (avoids partial-unique-index conflict while still supporting resolveIssue).
    const alertTitle = `${job.label} missed — ${now.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" })}`;
    const issueKey = `cron-stale:${job.agentType}:${dateStr}${job.requiresIndia ? ":india" : ":us"}`;
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
        summary: `${job.label} did not run today by ${job.expectedHour + job.graceHours}:00 UTC (expected ~${job.expectedHour}:00 UTC).`,
        resolved: false,
      });
    } catch { /* best-effort */ }

    const detail = [
      `Detected: ${fmtDateTime(now)}`,
      `Expected: ~${job.expectedHour}:00 UTC${job.fridayOnly ? " (Fridays)" : " weekdays"}`,
      `Likely cause: the Supabase pg_cron job did not fire, or the endpoint errored/timed out. These run in the cloud (pg_cron -> Vercel) and do NOT need your PC on.`,
      `Recovery: ${job.recoveryCmd}`,
    ].join(" · ");

    await svc.from("agent_alerts").insert({
      severity: "warn",
      category: "cron",
      issue_key: issueKey,
      title: alertTitle,
      detail,
      auto_expire_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
  }

  return NextResponse.json({ checked: true, hour, indiaEnabled, results });
}

// The checker writes alerts and journal rows through a service-role client, so
// it must never be a public GET endpoint. pg_cron uses POST; authenticated owner
// GET is retained for the dashboard/manual diagnostic workflow.
export async function POST(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCheck();
}

export async function GET(req: NextRequest) {
  if (!(await isAuthorized(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runCheck();
}
