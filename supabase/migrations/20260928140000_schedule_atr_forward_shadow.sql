begin;

-- Forward paired ATR-stop shadow book (US only). Measure-only: the collector
-- reads the paper ledger and writes upgrade_path_shadow_book_runs plus producer
-- health; nothing on an order, score, stop, target or sizing path reads either.
--
-- Corporate-action coverage runs pre-market (11:05-11:47 UTC, six minutes apart:
-- Massive is paced to 5 calls/minute, so one run certifies two symbols) and only
-- re-fetches coverage older than five days. The collector runs after every
-- season's US close (17:15 ET in EST, 18:15 ET in EDT) with one bounded retry;
-- it is idempotent and catches up at most five sessions per run.
do $$ begin perform cron.unschedule('kairos-corporate-action-coverage-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-atr-stop-forward-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-atr-stop-forward-us-retry'); exception when others then null; end $$;

select cron.schedule(
  'kairos-corporate-action-coverage-us', '5,11,17,23,29,35,41,47 11 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/corporate-action-coverage?market=us', '{}'::jsonb, 'POST', 58000)$$
);
select cron.schedule(
  'kairos-atr-stop-forward-us', '15 22 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/atr-stop-forward?market=us', '{}'::jsonb, 'POST', 58000)$$
);
select cron.schedule(
  'kairos-atr-stop-forward-us-retry', '45 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/atr-stop-forward?market=us', '{}'::jsonb, 'POST', 58000)$$
);

commit;
