-- Remote version 20261003143635; applied through Supabase MCP (project dionkikgdmlaotvtbnfr), 5 active jobs verified.
-- 1. Leveraged paper doors: a Monday (or post-holiday) entry window could never open in EDT months.
--    Each door's planner requires a successful run within 24 h ("monitor_unhealthy" otherwise), but the
--    previous run before Monday's 15:05 UTC entry is Friday's after-close run (~67 h earlier). A weekday
--    in-session liveness run at 14:35 UTC (10:35 ET in EDT, 09:35 ET in EST: always market hours) gives
--    every entry window a run less than an hour before it. Outside its entry window a flat door records
--    liveness without fetching quotes; a held door monitors its position with an in-session quote.
-- 2. ATR forward shadow book: Massive corporate-action coverage ran only 11:05-11:47 UTC, so any symbol
--    bought that afternoon had no coverage at the 22:15 UTC collector step and the whole session blocked
--    (MU, 2026-09-28), costing a session of lag per new entry. Evening coverage runs (4 x 2 symbols)
--    close that gap before the 22:15 step. Paper/measure-only; no orders, flags or scores change.
begin;

do $$ begin perform cron.unschedule('kairos-soxl-open'); exception when others then null; end $$;
select cron.schedule('kairos-soxl-open', '35 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/soxl/cron', '{}'::jsonb, 'POST', 58000)$$);
do $$ begin perform cron.unschedule('kairos-tqqq-open'); exception when others then null; end $$;
select cron.schedule('kairos-tqqq-open', '36 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/tqqq/cron', '{}'::jsonb, 'POST', 58000)$$);
do $$ begin perform cron.unschedule('kairos-sqqq-open'); exception when others then null; end $$;
select cron.schedule('kairos-sqqq-open', '37 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/sqqq/cron', '{}'::jsonb, 'POST', 58000)$$);
do $$ begin perform cron.unschedule('kairos-soxs-open'); exception when others then null; end $$;
select cron.schedule('kairos-soxs-open', '38 14 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/soxs/cron', '{}'::jsonb, 'POST', 58000)$$);

do $$ begin perform cron.unschedule('kairos-corporate-action-coverage-us-evening'); exception when others then null; end $$;
select cron.schedule('kairos-corporate-action-coverage-us-evening', '35,41,47,53 21 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/corporate-action-coverage?market=us', '{}'::jsonb, 'POST', 58000)$$);

commit;
