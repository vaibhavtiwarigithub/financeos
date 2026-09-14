-- Opt-in daily risk email — pg_cron schedule.
-- Spec: features/per-user-broker-risk/FEATURE_ARCHITECTURE.md §5 (Phase 3).
--
-- Runs HOURLY and sends only to users whose `send_hour_utc` equals the current
-- UTC hour. Recipients are spread across the world, so a single fixed send time
-- would land in the middle of the night for someone; the preference row carries
-- the hour and this job simply honours it.
--
-- Hourly firing does NOT mean hourly mail. Three independent limits:
--   1. `enabled` defaults FALSE — with nobody opted in, every run selects zero
--      rows and does nothing. That is the state today.
--   2. A UNIQUE INDEX on (user_id, send_date) makes a second send for the same
--      user on the same day impossible, and the sender writes that audit row
--      BEFORE calling the email provider, so a retry loses the race instead of
--      mailing twice.
--   3. MAX_SENDS_PER_RUN in the route caps any single run.
--
-- Read-only with respect to money: it reads already-computed user_* rows and
-- touches no order path, no owner table, and no LLM.
do $$
declare j text;
begin
  begin perform cron.unschedule('kairos-user-risk-email'); exception when others then null; end;
end $$;

select cron.schedule('kairos-user-risk-email', '5 * * * *',
  $$select kairos_call_agent('/api/agents/user-risk-email', '{}'::jsonb, 'POST', 290000)$$);
