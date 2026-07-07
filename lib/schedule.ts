// Kairos — single source of truth for every scheduled job.
//
// As of 2026-07-06 the authoritative schedule is the `kairos_pg_cron_vercel_schedule`
// / `kairos_cron_timeout_fix` Supabase migrations (pg_cron jobs named `kairos-*`,
// each firing net.http_post against the Vercel deployment). This survives the
// laptop being off. Only `db-backup` (nightly pg_dump) stays on local Windows
// Task Scheduler — Vercel serverless can't shell out to pg_dump. This file
// mirrors that live pg_cron state; edit it there (Supabase SQL) first, then
// update this file to match. Nothing here changes what actually runs — it
// only describes it.

export type Runner = "Supabase pg_cron → Vercel" | "Windows Task Scheduler";

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
 * Every scheduled job, mirroring the live `kairos-*` pg_cron jobs (Supabase).
 * Times are US-Eastern; pg_cron itself is scheduled in UTC assuming EDT
 * (summer) — needs a 1h shift when clocks change in November.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: "scan-india-refresh",
    agent: "scan-india-refresh",
    time: "6:45 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Nightly full-NSE pre-score cache refresh — rotates ~600 names/run so the India scanner reads the whole market.",
    handoff: "→ ResearchAgent (India)",
    agentRunsType: null,
  },
  {
    name: "research-india",
    agent: "research-india",
    time: "9:30 AM IST (~12:00 AM ET)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "India (NSE) signal generation, 15min after the 9:15 AM IST open — scores off yesterday's finalized close, then chains its own ₹ paper-trade fill using a live intraday quote. Realigned 2026-07-06 (migration 082) from a post-close time that scored and filled on the same closing print with no realistic gap between decision and fill.",
    handoff: "→ PaperTrader (India)",
    agentRunsType: "research",
  },
  {
    name: "position-monitor-india",
    agent: "position-monitor-india",
    time: "7:15 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Exit/stop checks for open India positions.",
    handoff: "→ LearnerAgent",
    agentRunsType: "position_monitor",
  },
  {
    name: "brief-morning",
    agent: "brief-morning",
    time: "10:00 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Generates and emails the morning briefing — moved to fire AFTER research+trader (was 8 AM, before signals existed) so it reflects the day's real output instead of pre-scan filler.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "brief-morning-india",
    agent: "brief-morning-india",
    time: "9:50 AM IST (~12:20 AM ET)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "India's own morning briefing (added 2026-07-06) — fires 20min after kairos-research-india so the day's India signals/paper-fill have already landed. Briefing/generate now accepts market:india and pulls the India paper pool + NIFTY/SENSEX instead of US indices.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "research",
    agent: "research",
    time: "9:00 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Pre-market signal generation (US). ResearchAgent scores existing holdings (SELL allowed) and dual-bucket screener candidates (LONG only), writing signals scored ≥60 as buy candidates. Also fires Theme Scout automatically.",
    handoff: "→ PaperTrader (signals scored ≥60 become buy candidates)",
    agentRunsType: "research",
  },
  {
    name: "trader",
    agent: "trader",
    time: "9:45 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Proposal generation. TraderAgent turns qualifying research signals into sized paper-trade proposals in approval-required mode.",
    handoff: "→ PositionMonitor (open positions tracked for exits)",
    agentRunsType: "paper_trader",
  },
  {
    name: "broker-sync",
    agent: "broker-sync",
    time: "Every 30 min, 9:30 AM–4:00 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Execution Gateway sync — polls the active broker (Alpaca/Kite) for order-status updates and reconciles positions.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "macro-sentinel",
    agent: "macro-sentinel",
    time: "Monday 8:30 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Weekly recession early-warning read across 8 economic indicators. Advisory only.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "position-monitor",
    agent: "position-monitor",
    time: "4:15 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "End-of-day exit and stop checks (US). Reviews every open position against stop-loss, take-profit and thesis-invalidation rules and flags exits.",
    handoff: "→ LearnerAgent (closed trades become learning outcomes)",
    agentRunsType: "position_monitor",
  },
  {
    name: "brief-evening",
    agent: "brief-evening",
    time: "4:30 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Generates and emails the evening summary — how the book did today, realized/unrealized P&L, exits taken and what to watch tomorrow.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "brief-evening-india",
    agent: "brief-evening-india",
    time: "4:30 PM IST (~7:00 AM ET)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "India's own evening summary (added 2026-07-06) — fires 45min after kairos-position-monitor-india and NSE's 3:30 PM close, once the day's exits/closing prices have settled.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "rescore",
    agent: "rescore",
    time: "4:45 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
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
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Refreshes RAG embeddings — vectorizes the day's new signals, notes and closed-trade summaries so the knowledge base stays queryable.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "nav-snapshot",
    agent: "nav-snapshot",
    time: "5:00 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Daily NAV / alpha snapshot. Records end-of-day net asset value, benchmark and computed alpha so the performance history and equity curve advance one day.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "label-maturation",
    agent: "label-maturation",
    time: "6:00 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Learning-core Phase 1 — matures decision_observations into observation_labels once the forward horizon (2/5/10/20 days) has passed.",
    handoff: "→ Validation Engine / calibration fit",
    agentRunsType: null,
  },
  {
    name: "feature-check",
    agent: "feature-check",
    time: "4:30 PM ET",
    days: "Friday",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Learning-core Phase 3 — weekly feature-registry IC check (proposed → quarantined → active promotion / retirement).",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "fit-calibration",
    agent: "fit-calibration",
    time: "4:45 PM ET",
    days: "Friday",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Learning-core Phase 2 — weekly refit of the calibrated P(win) sizing model per market (dormant until 60+ matured labels exist).",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "learner",
    agent: "learner",
    time: "5:00 PM ET",
    days: "Friday",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Weekly weight learning. LearnerAgent runs a batch over the week's closed trades and proposes weight challengers (requires 10+ closed trades before mutation unlocks).",
    handoff: "→ Strategy Registry (weight challengers await promotion)",
    agentRunsType: "learner",
  },
  {
    name: "learner-india",
    agent: "learner",
    time: "3:30 PM ET",
    days: "Friday",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Weekly weight learning for the India market (market=india). Runs the same LearnerAgent over India's own closed-trade cohort and proposes challengers for India's champion only — a bad India run can never shift US scoring. Same 10+ closed-trade phase gate.",
    handoff: "→ Strategy Registry (India weight challengers await promotion)",
    agentRunsType: "learner",
  },
  {
    name: "macro-read-us",
    agent: "macro-read",
    time: "9:30 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Agent Mind Phase 3: generates the plain-English 'what the macro backdrop means for your book' read (US) — macro regime + holdings + macro priors → one cheap cached LLM call/day. Advisory only; shown on Markets. Never trades or sizes.",
    handoff: "→ Markets page 'What this means for your book' card",
    agentRunsType: null,
  },
  {
    name: "macro-read-india",
    agent: "macro-read",
    time: "10:00 AM IST",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Agent Mind Phase 3: India macro-to-holdings read (market=india). Same cheap cached daily call, scoped to the India book and regime.",
    handoff: "→ Markets page (India)",
    agentRunsType: null,
  },
  {
    name: "mentor-coach",
    agent: "mentor-coach",
    time: "5:15 PM ET",
    days: "Friday",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Weekly coaching. The MentorAgent (deepseek-reasoner) reads your behavior + learning progress + market regime and writes personalized coaching to mentor_insights. Advisory only — nothing else reads this table as an input.",
    handoff: "→ Mentor 'AI Coach' tab + the daily briefing",
    agentRunsType: null,
  },
  {
    name: "model-check",
    agent: "model-check",
    time: "Monday 7:30 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Model-freshness check — diffs agent_config's model assignments against each provider's live model list. Informational only, never auto-switches.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "proposal-reminder",
    agent: "proposal-reminder",
    time: "Every 15 min, 9:00 AM–5:00 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
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
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Stale-run alerts. Every 4 hours (all days) it verifies each scheduled agent actually ran on time and raises an alert if a cron has gone silent.",
    handoff: null,
    agentRunsType: null,
  },
  {
    name: "db-backup",
    agent: "db-backup",
    time: "3:00 AM (local)",
    days: "Daily",
    runner: "Windows Task Scheduler",
    editable: false,
    description:
      "Nightly Postgres backup (pg_dump). Stays local — Vercel serverless can't shell out to pg_dump. Requires SUPABASE_DB_URL to be set correctly in .env.local (currently unverified).",
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
