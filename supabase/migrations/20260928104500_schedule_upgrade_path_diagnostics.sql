begin;

-- These two read-only evidence producers were listed in the registry and
-- displayed as weekly schedules, but no migration created their cron jobs.
-- Each market remains isolated and writes only its own evidence ledger.
do $$ begin perform cron.unschedule('kairos-alpha-diagnostics-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-alpha-diagnostics-india'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-archetype-ic-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-archetype-ic-india'); exception when others then null; end $$;

select cron.schedule(
  'kairos-alpha-diagnostics-us', '10 4 * * 0',
  $$select public.kairos_call_agent('/api/analytics/alpha-diagnostics?market=us', '{}'::jsonb, 'POST', 120000)$$
);
select cron.schedule(
  'kairos-alpha-diagnostics-india', '20 4 * * 0',
  $$select public.kairos_call_agent('/api/analytics/alpha-diagnostics?market=india', '{}'::jsonb, 'POST', 120000)$$
);
select cron.schedule(
  'kairos-archetype-ic-us', '40 3 * * 0',
  $$select public.kairos_call_agent('/api/agents/archetype-ic?market=us', '{}'::jsonb, 'POST', 120000)$$
);
select cron.schedule(
  'kairos-archetype-ic-india', '50 3 * * 0',
  $$select public.kairos_call_agent('/api/agents/archetype-ic?market=india', '{}'::jsonb, 'POST', 120000)$$
);

commit;
