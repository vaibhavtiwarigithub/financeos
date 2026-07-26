-- ============================================================
-- 20260725120000_order_maintenance_cron.sql
-- pg_cron job: cancel stale orders + reconcile unknown_needs_reconcile
-- every 30 minutes.
--
-- Cancels broker_orders in pending_submit/submitted for >30 min (US only).
-- Reconciles unknown_needs_reconcile rows by polling Robinhood order status.
--
-- Auth: kairos_cron_secret vault secret (same as all other crons).
-- ============================================================

SELECT cron.unschedule('order-maintenance')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'order-maintenance');

SELECT cron.schedule(
  'order-maintenance',
  '*/30 * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://financeos-phi.vercel.app/api/agents/order-maintenance',
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

-- Verify: SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'order-maintenance';
