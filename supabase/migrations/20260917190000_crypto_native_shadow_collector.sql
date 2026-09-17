-- Crypto-native daily evidence collector. The crypto paper entry route remains
-- paper-only and fail-closed; this job writes only universe/shadow evidence.
-- 00:15 UTC is after the declared completed-daily-bar boundary and before the
-- position monitor at 00:30 UTC. Unlike an equity job, it runs all seven days.
do $$
begin
  begin perform cron.unschedule('kairos-crypto-native-shadow'); exception when others then null; end;
end $$;

select cron.schedule(
  'kairos-crypto-native-shadow',
  '15 0 * * *',
  $$select public.kairos_call_agent('/api/agents/crypto-research-shadow', '{}'::jsonb, 'POST', 60000)$$
);
