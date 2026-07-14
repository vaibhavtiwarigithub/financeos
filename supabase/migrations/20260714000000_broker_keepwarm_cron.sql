-- MCP broker token keep-warm cron.
--
-- OAuth access tokens are short-lived (Webull ~1 day). The refresh chain self-
-- renews only if some caller invokes getValidAccessToken before the refresh
-- token's own window lapses. Market-hours crons (broker-sync, research) already
-- do this on weekdays, but leave gaps over weekends/holidays. This job hits the
-- keep-warm route every 12h EVERY day so the chain can never lapse.
--
-- Runs 06:00 and 18:00 UTC daily. Read-only (no tool calls, no order path).
select cron.schedule(
  'kairos-broker-keepwarm',
  '0 6,18 * * *',
  $$select public.kairos_call_agent('/api/broker-mcp/keepwarm', '{}'::jsonb, 'POST', 55000)$$
);
