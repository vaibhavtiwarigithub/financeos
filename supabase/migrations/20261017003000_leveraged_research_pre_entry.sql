-- Market-local US research pass for the four dedicated leveraged-ETF paper doors.
-- The generic 09:00 ET pass is holdings-first and can budget-defer all candidates;
-- a separate 10:30 ET pass provides timely deterministic evidence before 11:00–12:00 ET.
-- Both UTC schedules are installed year-round; local_slot admits exactly one
-- across DST. This adds no trade authority and changes no live setting.
begin;
do $$ begin
  perform cron.unschedule('kairos-research-leveraged-us');
exception when others then null; end $$;
select cron.schedule(
  'kairos-research-leveraged-us', '30 14,15 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&scope=leveraged&local_slot=10%3A30', '{}'::jsonb, 'POST', 160000)$$
);
commit;
