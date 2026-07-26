-- ============================================================
-- 20260725100000_weekend_research_crons.sql
-- Daily catch-up crons for US and India research pipelines.
--
-- These run every day (including weekends and market holidays).
-- On regular trading days they self-skip (getClosedDayCatchupEligibility
-- returns eligible=false, route returns {skipped:true} — no AV calls made).
-- On weekends and holidays they run and write status='weekend_staged'
-- signals, which cannot trigger orders until Monday/next-session validation.
--
-- Combined with the existing weekday cron (022_research_cron.sql) the
-- full schedule becomes:
--   Trading days:  weekday cron fires normally (pending signals, paper-trade chain)
--   Closed days:   these crons fire (weekend_staged signals only)
--
-- Schedules (both daily):
--   research-agent-catchup-us    → 14:00 UTC (10:00 AM ET)
--   research-agent-catchup-india → 04:00 UTC (09:30 AM IST)
--
-- Auth: kairos_cron_secret vault secret (same as weekday crons).
-- ============================================================

-- Idempotent cleanup of any prior version.
SELECT cron.unschedule('research-agent-weekend-us')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research-agent-weekend-us');

SELECT cron.unschedule('research-agent-weekend-india')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research-agent-weekend-india');

SELECT cron.unschedule('research-agent-catchup-us')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research-agent-catchup-us');

SELECT cron.unschedule('research-agent-catchup-india')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'research-agent-catchup-india');

-- US daily catch-up — 14:00 UTC every day (self-skips on trading days).
SELECT cron.schedule(
  'research-agent-catchup-us',
  '0 14 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://financeos-phi.vercel.app/api/agents/research/cron?market=us&mode=weekend_catchup',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'kairos_cron_secret'
        LIMIT 1
      )
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- India daily catch-up — 04:00 UTC every day (self-skips on trading days).
SELECT cron.schedule(
  'research-agent-catchup-india',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://financeos-phi.vercel.app/api/agents/research/cron?market=india&mode=weekend_catchup',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', (
        SELECT decrypted_secret
        FROM vault.decrypted_secrets
        WHERE name = 'kairos_cron_secret'
        LIMIT 1
      )
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);

-- Verify: SELECT jobid, jobname, schedule, active FROM cron.job
-- WHERE jobname LIKE 'research-agent-catchup-%';
