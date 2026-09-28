begin;

-- The US post-close price prewarm must run ~95 minutes after the close in both
-- seasons. NYSE closes 20:00 UTC in EDT and 21:00 UTC in EST, so one fixed UTC
-- time cannot serve both: 21:35 UTC is 95 minutes after an EDT close but only
-- 35 minutes after an EST close, the same too-early failure fixed on
-- 2026-09-24. EDT months keep 21:35/21:40; EST months (and the two transition
-- months, where 22:35 is safe in either season) run an hour later.
do $$ begin perform cron.unschedule('kairos-price-prewarm-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-price-prewarm-us-est'); exception when others then null; end $$;

select cron.schedule(
  'kairos-price-prewarm-us', '35,40 21 * 4-10 1-5',
  $$select public.kairos_call_agent('/api/agents/price-prewarm?market=us', '{}'::jsonb, 'POST', 58000)$$
);
select cron.schedule(
  'kairos-price-prewarm-us-est', '35,40 22 * 11,12,1,2,3 1-5',
  $$select public.kairos_call_agent('/api/agents/price-prewarm?market=us', '{}'::jsonb, 'POST', 58000)$$
);

commit;
