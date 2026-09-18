-- Crypto trades seven days a week. Replace the legacy weekday schedule with a
-- daily post-session run, after the 00:15 UTC native evidence collector and
-- 00:30 UTC monitor. The route still refuses stale/invalid data; this changes
-- cadence, not the paper/live boundary.
do $$
begin
  begin perform cron.unschedule('kairos-crypto-paper-trade'); exception when others then null; end;
end $$;

select cron.schedule(
  'kairos-crypto-paper-trade',
  '45 0 * * *',
  $$select public.kairos_call_agent('/api/agents/crypto-paper-trade', '{}'::jsonb, 'POST', 60000)$$
);
