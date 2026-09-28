begin;

-- Decision-level ATR-stop shadow collector only. This does not place orders,
-- change live/paper policy, or create portfolio-P&L attribution.
-- Preserve the production weekly cadence verified on 2026-09-27. The job
-- names already existed in pg_cron but were missing from repository migrations.
do $$ begin
  perform cron.unschedule('kairos-exit-stop-shadow-us');
exception when others then null;
end $$;

do $$ begin
  perform cron.unschedule('kairos-exit-stop-shadow-india');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-exit-stop-shadow-us', '20 4 * * 0',
  $$select public.kairos_call_agent('/api/agents/exit-stop-shadow?market=us', '{}'::jsonb, 'POST', 60000)$$
);

select cron.schedule(
  'kairos-exit-stop-shadow-india', '30 4 * * 0',
  $$select public.kairos_call_agent('/api/agents/exit-stop-shadow?market=india', '{}'::jsonb, 'POST', 60000)$$
);

commit;
