-- ============================================================
-- 022_research_cron.sql
-- Schedule: Research Agent runs every weekday at 14:30 UTC
--           (9:30 AM ET — market open)
--
-- Extensions required (already enabled on this project):
--   pg_cron  v1.6.4  — job scheduler
--   pg_net   v0.20.3 — outbound HTTP from Postgres
--
-- Auth header: x-cron-secret: fos-cron-k9x2m7p4-2026
--   (matches CRON_SECRET env var checked in /api/agents/research/cron)
--
-- IMPORTANT — localhost limitation:
--   pg_cron runs inside Supabase infrastructure and CANNOT reach
--   http://localhost:3000.  This job must target the real production
--   or staging URL of the Next.js app.
--
--   Replace {{APP_URL}} below with the actual deployed URL before
--   applying this migration in production, e.g.:
--     https://finance-os.vercel.app
--     https://app.financeos.io
--
--   In development, trigger the cron manually:
--     curl -X POST http://localhost:3000/api/agents/research/cron \
--          -H "x-cron-secret: fos-cron-k9x2m7p4-2026"
--
--   Or use Windows Task Scheduler (already in place per route comment).
-- ============================================================

-- Extensions are already enabled; these are idempotent no-ops.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove any stale version of this job before (re)creating it.
SELECT cron.unschedule('research-agent-daily')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research-agent-daily');

-- Schedule the research cron.
-- Cron expression: 30 14 * * 1-5  →  14:30 UTC, Mon–Fri
--
-- What this triggers:
--   POST /api/agents/research/cron
--   1. Checks app_paused flag (skips if paused)
--   2. Calls gatherSymbols() — existing holdings + screener candidates
--   3. Calls processSymbol() for each — writes signals to agent_signals
--   4. Chains /api/agents/paper-trade automatically
--   5. Chains /api/agents/theme-scout (async, fire-and-forget)
--   6. Pre-warms price_cache for all researched + benchmark symbols
--   7. Emits agent_alerts on failures
SELECT cron.schedule(
  'research-agent-daily',                 -- job name
  '30 14 * * 1-5',                        -- 9:30 AM ET, weekdays
  $$
  SELECT net.http_post(
    url     := '{{APP_URL}}/api/agents/research/cron',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-cron-secret',  'fos-cron-k9x2m7p4-2026'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Verify the job was created.
-- SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'research-agent-daily';
