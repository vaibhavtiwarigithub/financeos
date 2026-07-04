-- Migration 052: unschedule legacy pg_cron jobs
--
-- Deep architecture review (2026-07-04) found 10 ACTIVE pg_cron jobs still
-- scheduled from early development, all using the OLD rotated-out cron secret
-- ('fos-cron-k9x2m7p4-2026', superseded by the current CRON_SECRET), targeting
-- Supabase Edge Functions that proxy to APP_URL/api/... routes.
--
-- Decision 20 (PROJECT_DECISIONS.md) already declared cloud edge-function crons
-- decommissioned in favor of Windows Task Scheduler as the single source of
-- truth (see lib/schedule.ts). These pg_cron jobs were dormant only because no
-- public APP_URL is configured (this app runs local-only) — if the app is ever
-- deployed publicly without addressing this, they would fire in PARALLEL with
-- Windows Task Scheduler, causing duplicate signal generation, duplicate paper
-- fills, and duplicate emails, all authenticated with a secret that should no
-- longer work.
--
-- Unscheduled: theme-scout-daily, briefing-morning, briefing-evening,
-- macro-sentinel-weekly, position-monitor-daily, deepseek-research-daily,
-- research-agent-daily, paper-trader-daily, learner-agent-weekly,
-- newsletter-morning, newsletter-evening.
--
-- Underlying Edge Functions (paper-trader, position-monitor, research-agent,
-- learner-agent, deepseek-research, newsletter-daily) were already stubbed to
-- return 410 Gone in an earlier session. theme-scout/briefing-generate/
-- macro-sentinel edge functions still contain live proxy logic but are now
-- unreachable without an active pg_cron trigger.

DO $$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname IN (
    'theme-scout-daily','briefing-morning','briefing-evening','macro-sentinel-weekly',
    'position-monitor-daily','deepseek-research-daily','research-agent-daily',
    'paper-trader-daily','learner-agent-weekly','newsletter-morning','newsletter-evening'
  );
EXCEPTION WHEN OTHERS THEN
  -- Best-effort: jobs may already be gone if this migration re-runs.
  NULL;
END $$;
