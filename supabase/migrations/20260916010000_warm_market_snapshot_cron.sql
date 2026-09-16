-- Schedule the US market snapshot warm job.
-- Runs at 21:15 UTC (= 16:15 ET / 17:15 EDT), Mon-Fri — after NYSE close.
-- Warms market_overview_snapshots so viewer requests never trigger a live
-- Massive provider call.
--
-- Replace {{APP_URL}} with the actual deployed URL before applying.
-- Replace <CRON_SECRET> with the value of the CRON_SECRET env var.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('warm-market-snapshot')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'warm-market-snapshot');

SELECT cron.schedule(
  'warm-market-snapshot',
  '15 21 * * 1-5',
  $$
  SELECT net.http_post(
    url     := '{{APP_URL}}/api/cron/warm-market-snapshot',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body    := '{}'::jsonb
  ) AS request_id;
  $$
);
