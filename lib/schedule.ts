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

export type ScheduleDays = "Weekdays" | "Friday" | "Weekly" | "Daily";

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
 * Times are exchange-local. US jobs use paired EDT/EST UTC hours plus a strict
 * route-level local_slot guard, so no manual November shift is required.
 */
export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  {
    name: "international-allocation-shadow",
    agent: "international-allocation-shadow",
    time: "Sunday 10:30 PM CT (Monday 03:30 UTC)",
    days: "Weekly",
    runner: "Supabase pg_cron \u2192 Vercel",
    editable: false,
    description:
      "P2A US/USD VXUS allocation shadow: appends one persisted-paper-position assessment with a suppressed no-action while target and band remain unset. No provider, candidate, paper/live execution, broker, or India read.",
    handoff: "â†’ International Allocation evidence ledger (observation only)",
    agentRunsType: null,
  },
  {
    name: "earnings-pit-capture",
    agent: "earnings-pit-capture",
    time: "10:10 PM ET (02:10 UTC next day)",
    days: "Daily",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Point-in-time US earnings capture: appends changing pre-report consensus vintages and stores the first provider actual observed after release. Capture-only; no scoring or order consumer.",
    handoff: "→ Earnings PIT coverage report (future PEAD feasibility only)",
    agentRunsType: null,
  },
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
    name: "india-markets-fill",
    agent: "india-markets-fill",
    time: "6:15 AM ET (retry 6:35 AM ET)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Post-close India Markets display snapshot: one paced, deduplicated server fetch for indices, sectors, and versioned NIFTY-50 breadth. Retry moved to 10:35 UTC so it does not collide with the 10:45 India scanner.",
    handoff: "→ Markets page India cache",
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
    handoff: "→ PaperTrader India (chained fill primary; kairos-paper-trade-india standalone backstop)",
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
      "US signal generation at a DST-safe 09:00 New York local slot. Daily technicals use completed sessions only. ResearchAgent scores holdings (SELL allowed) and candidates (LONG only); PaperTrader is a separate scheduled consumer.",
    handoff: "→ PaperTrader US (standalone cron + chain backstop; signals scored ≥60 become buy candidates)",
    agentRunsType: "research",
  },
  {
    name: "paper-trade-us",
    agent: "paper-trade-us",
    time: "11:15 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Standalone US ($) paper fill at a DST-safe 11:15 New York local slot. Fills only fresh same-session deterministic long signals; stale rows expire and the exchange-session guard remains independent.",
    handoff: "→ PositionMonitor (open positions tracked for exits)",
    agentRunsType: "paper_trader",
  },
  {
    name: "paper-trade-india",
    agent: "paper-trade-india",
    time: "9:40 AM IST",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Standalone India (₹) paper fill inside the NSE session. Only fresh same-IST-day deterministic long signals fill; stale pending rows expire.",
    handoff: "→ PositionMonitor (India)",
    agentRunsType: "paper_trader",
  },
  {
    name: "research-us-pm",
    agent: "research-us-pm",
    time: "2:00 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description: "Second DST-safe US research pass. Uses completed daily sessions only; the current intraday daily bar cannot change technical scoring.",
    handoff: "→ PaperTrader US PM",
    agentRunsType: "research",
  },
  {
    name: "paper-trade-us-pm",
    agent: "paper-trade-us-pm",
    time: "3:15 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description: "Second DST-safe US paper-entry/rotation attempt inside the regular session.",
    handoff: "→ PositionMonitor",
    agentRunsType: "paper_trader",
  },
  {
    name: "india-news-shadow",
    agent: "india-news-shadow",
    time: "5:45 PM IST",
    days: "Daily",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description: "India-only NSE corporate-announcement and Google News RSS coverage shadow. Canonical evidence/audit writes only; no score or execution reader.",
    handoff: "→ Upgrade Path evidence review",
    agentRunsType: "india_news_shadow",
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
      "DST-safe 4:15 PM ET exit and stop checks (US), always after the regular close. Reviews open positions against deterministic score, stop, target, time and partial-profit rules.",
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
    name: "earnings-risk-monitor-us",
    agent: "earnings-risk-monitor",
    time: "16:00 UTC (11 AM/12 PM ET)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "US holdings-only earnings/options shadow. Reads open paper positions and latest complete live-risk snapshots; records event magnitude context without changing scores, positions, or trades.",
    handoff: "to Portfolio Risk / Upgrade Path evidence",
    agentRunsType: "earnings_risk_monitor",
  },
  {
    name: "alpha-diagnostics-us",
    agent: "alpha-diagnostics",
    time: "Sun 4:10 AM UTC",
    days: "Weekly",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Alpha Diagnostic Lab. Read-only funnel diagnosis: data truth, selection, payoff geometry, exit paths, sizing and cost. Runs A0 FIRST and refuses to interpret anything downstream if data truth fails. Strongest verdict is owner_review; it has no write path to any money-path table.",
    handoff: "→ backtest_experiments (evidence only)",
    agentRunsType: null,
  },
  {
    name: "alpha-diagnostics-india",
    agent: "alpha-diagnostics",
    time: "Sun 4:20 AM UTC",
    days: "Weekly",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "India leg. Separate run, separate evidence, separate verdict — US and India never share capital, benchmark, thresholds or conclusions.",
    handoff: "→ backtest_experiments (evidence only)",
    agentRunsType: null,
  },
  {
    name: "archetype-ic-us",
    agent: "archetype-ic",
    time: "Sun 3:40 AM UTC",
    days: "Weekly",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Measure-only. Grades every archetype weight set recorded in shadow_decisions against realized benchmark-neutral forward returns, alongside the champion composite measured on the SAME observations. Weekly because the input only changes as labels mature. Writes archetype_ic_runs; nothing in the money path reads it.",
    handoff: "→ archetype_ic_runs (evidence only)",
    agentRunsType: null,
  },
  {
    name: "archetype-ic-india",
    agent: "archetype-ic",
    time: "Sun 3:50 AM UTC",
    days: "Weekly",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "India leg of the archetype IC evaluator. It grades each weighting arm on the entry-eligible long cohort only. The fundamental_only arm runs in BOTH markets deliberately - an arm that only runs where it is expected to win proves nothing. (Corrected 2026-08-28: this previously stated India's measured edge sits in technical rather than fundamental. That came from the all-scored cohort; on the eligible-entry cohort India measures -0.0083 and no dimension ranking has been established.)",
    handoff: "→ archetype_ic_runs (evidence only)",
    agentRunsType: null,
  },
  {
    name: "horizon-extension-shadow-us",
    agent: "horizon-extension-shadow",
    time: "4:05 PM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Measure-only. Records what the conditional horizon-extension policy WOULD have decided for every open US paper position, 10 minutes before PositionMonitor's unconditional time stop fires. Nothing reads its output; it cannot close, hold, size, or suppress an exit. Exists because ~75% of closed US lots exit on the time stop with no reference to P&L, trend or score.",
    handoff: "→ horizon_extension_shadow (evidence only)",
    agentRunsType: null,
  },
  {
    name: "horizon-extension-shadow-india",
    agent: "horizon-extension-shadow",
    time: "4:35 PM IST",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Measure-only India leg of the horizon-extension shadow, 10 minutes before the India PositionMonitor. India's time stop currently harvests winners (66% win rate) where the US clock mostly clears weak positions, which is why the policy decides per position rather than extending globally.",
    handoff: "→ horizon_extension_shadow (evidence only)",
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
      "Learning-core Phase 1 — matures decision_observations into observation_labels once the forward horizon (2/5/10/20/60/120 days) has passed. The 60/120 horizons measure exit timing and are decoupled from the 5-15 day holding period.",
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
    name: "price-cache-fill",
    agent: "price-cache-fill",
    time: "9:25 AM ET (retry 9:45)",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Pre-market fill of price_cache with the whole Markets ETF universe (regime proxies, 11 sector XLs, leveraged pairs) via ONE grouped-daily Massive call, so the Markets tiles read a warm cache instead of each bursting Massive's ~5/min free tier on page load. Display data only — never on the money/scoring path. Idempotent: the 9:45 tick is a no-op once the 9:25 tick has filled.",
    handoff: "→ Markets page tiles (synthesis, overview, quotes, sector returns)",
    agentRunsType: null,
  },
  {
    name: "symbol-profiles-backfill",
    agent: "symbol-profiles-backfill",
    time: "7:40 AM ET",
    days: "Weekdays",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Pre-market fill of symbol_profiles (Stock Context 'what is this stock' layer) for watchlist symbols lacking a fresh (<30d) profile, and backfill of watchlist.company_name where null, from Finnhub/Yahoo. Bounded by a ~90s wall-clock budget and idempotent — fresh profiles are skipped and the rest re-defer to the next run. Covers both US + India watchlist symbols in one pass. Display data only — never on the money/scoring path.",
    handoff: "→ Watchlist / Stock Context display",
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
    name: "watchdog",
    agent: "watchdog",
    time: "Every 2 hours",
    days: "Daily",
    runner: "Supabase pg_cron → Vercel",
    editable: false,
    description:
      "Pipeline janitor (added 2026-07-08, migration 131). Reaps zombie agent_runs (status='running' past 15min — longer than any Vercel function can live), reverts orphaned 'claiming' signals back to pending (clearing claim stamps so a later paper-trade run can pick them up), and expires stale pending long signals per market-local day. Bounded status corrections only — never touches money, positions, ledgers, or config.",
    handoff: null,
    agentRunsType: "watchdog",
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
