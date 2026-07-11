-- Migration 157: pg_cron schedule for live-exit-monitor via pg_net
-- Runs hourly 03:00–20:00 UTC Mon–Fri, covers both US (13:30–20:00) and
-- India (03:45–10:00) sessions. No-op unless AUTONOMOUS_LIVE_ENABLED is set
-- and live_auto_enabled DB toggle is on.
-- Replaces the removed Vercel cron entry (Hobby plan: max 1 fire/day).

-- Historical migration retained for ordering. The credential originally placed
-- here was revoked; migration 159 replaces this raw command with the Vault-backed
-- kairos_call_agent helper. Never put credentials in migration SQL.
select cron.schedule(
  'kairos-live-exit-monitor',
  '0 3-20 * * 1-5',
  $$
  select net.http_post(
    url     := 'https://financeos-phi.vercel.app/api/agents/live-exit-monitor/cron',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := '{}'::jsonb,
    timeout_milliseconds := 25000
  )
  $$
);
