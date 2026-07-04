// Kairos — single source of truth for every scheduled job.
//
// This file mirrors scripts/register-tasks.ps1 (the authoritative registrar) and
// scripts/run-agents.ps1 (which maps each task name to the API endpoint it hits).
// If you change a schedule, edit register-tasks.ps1 and re-run it, then update this
// file to match. Nothing here changes what actually runs — it only describes it.
//
// NOTE: Cloud / Supabase edge-function crons were DECOMMISSIONED. Every job below now
// runs locally via Windows Task Scheduler under the "\Kairos" task folder. Schedules are
// therefore read-only inside the app — the only way to edit them is to edit
// scripts/register-tasks.ps1 and re-run it as the app user.

export type Runner = "Windows Task Scheduler";

export type ScheduleDays = "Weekdays" | "Friday" | "Daily";

export interface ScheduledJob {
  /** Task name as registered under \Kairos in Task Scheduler (e.g. "brief-morning"). */
  name: string;
  /** The -Agent value passed to run-agents.ps1. Maps to an agent_type where one exists. */
  agent: string;
  /** Human-readable trigger time in US-Eastern, matching register-tasks.ps1. */
  time: string;
  /** Which days the trigger fires. */
  days: ScheduleDays;
  /** Where the job runs. All jobs are local Windows Task Scheduler tasks. */
  runner: Runner;
  /** Whether the schedule can be edited from inside the app. Always false — edit the .ps1. */
  editable: false;
  /** What the job does. */
  description: string;
  /** What this job feeds next in the pipeline, or null if it is terminal / advisory. */
  handoff: string | null;
  /**
   * agent_type key in the agent_runs table, if this job writes agent_runs rows.
   * null for jobs (proposal-reminder, stale-check, embed, rescore, briefs) that do not.
   */
  agentRunsType: string | null;
}

/**
 * Every scheduled job, verbatim from scripts/register-tasks.ps1.
 * Times are US-Eastern (the box the scheduler runs on is set to ET).
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: "brief-morning",
    agent: "brief-morning",
    time: "8:00 AM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Generates and emails the morning briefing — overnight moves, open positions, today's catalysts and the pre-market read.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "research",
    agent: "research",
    time: "9:00 AM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Pre-market signal generation. ResearchAgent scores existing holdings (SELL allowed) and dual-bucket screener candidates (LONG only), writing signals scored ≥60 as buy candidates.",
    handoff: "→ PaperTrader (signals scored ≥60 become buy candidates)",
    agentRunsType: "research",
  },
  {
    name: "trader",
    agent: "trader",
    time: "9:45 AM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Proposal generation. TraderAgent turns qualifying research signals into sized paper-trade proposals in approval-required mode.",
    handoff: "→ PositionMonitor (open positions tracked for exits)",
    agentRunsType: "paper_trader",
  },
  {
    name: "position-monitor",
    agent: "position-monitor",
    time: "4:15 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "End-of-day exit and stop checks. Reviews every open position against stop-loss, take-profit and thesis-invalidation rules and flags exits.",
    handoff: "→ LearnerAgent (closed trades become learning outcomes)",
    agentRunsType: "position_monitor",
  },
  {
    name: "brief-evening",
    agent: "brief-evening",
    time: "4:30 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Generates and emails the evening summary — how the book did today, realized/unrealized P&L, exits taken and what to watch tomorrow.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "rescore",
    agent: "rescore",
    time: "4:45 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Scoring calibration check. Re-scores recent signals against realized outcomes to detect drift between the scoring model and what actually worked.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "embed",
    agent: "embed",
    time: "4:50 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Refreshes RAG embeddings — vectorizes the day's new signals, notes and closed-trade summaries so the knowledge base stays queryable. First run does a large backfill (10-min limit).",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "nav-snapshot",
    agent: "nav-snapshot",
    time: "5:00 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Daily NAV / alpha snapshot. Records end-of-day net asset value, benchmark and computed alpha so the performance history and equity curve advance one day.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "learner",
    agent: "learner",
    time: "5:00 PM ET",
    days: "Friday",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Weekly weight learning. LearnerAgent runs a batch over the week's closed trades and proposes weight challengers (requires 10+ closed trades before mutation unlocks).",
    handoff: "→ Strategy Registry (weight challengers await promotion)",
    agentRunsType: "learner",
  },
  {
    name: "mentor-coach",
    agent: "mentor-coach",
    time: "5:15 PM ET",
    days: "Friday",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Weekly coaching. The Mentor scores the week's theses and decisions and writes coaching feedback to the decision journal.",
    handoff: "→ Decision Journal (thesis scored for the user)",
    agentRunsType: "mentor_evaluate",
  },
  {
    name: "proposal-reminder",
    agent: "proposal-reminder",
    time: "Every 15 min, 9:00 AM–5:00 PM ET",
    days: "Weekdays",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Proposal expiry reminders. Every 15 minutes during market hours it checks for pending trade proposals nearing expiry and nudges before they lapse.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "stale-check",
    agent: "stale-check",
    time: "Every 4 hours",
    days: "Daily",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Stale-run alerts. Every 4 hours (all days) it verifies each scheduled agent actually ran on time and raises an alert if a cron has gone silent.",
    handoff: null,
    agentRunsType: null,
  },
] as const;

/** All distinct agent_runs types referenced by the schedule (for the join in the API). */
export const SCHEDULED_AGENT_RUN_TYPES: string[] = Array.from(
  new Set(
    SCHEDULED_JOBS.map((j) => j.agentRunsType).filter(
      (t): t is string => t != null,
    ),
  ),
);
