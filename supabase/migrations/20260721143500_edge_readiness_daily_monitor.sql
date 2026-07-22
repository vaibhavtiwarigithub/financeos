-- Daily provider-free readiness checks detect a missed weekly EdgeIC run promptly.
do $$ begin
  perform cron.unschedule('kairos-edge-readiness');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-edge-readiness', '20 3 * * *',
  $$select public.kairos_call_agent('/api/agents/edge-readiness', '{}'::jsonb, 'POST', 60000)$$
);
