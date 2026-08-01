-- Keep the existing bounded US EdgeScout workload, but rotate it through the
-- curated liquid universe so candidate discovery can reach beyond the watchlist.
-- This is current-session discovery only, never a historical PIT claim.
select cron.unschedule('kairos-edge-scout-us') where exists (
  select 1 from cron.job where jobname = 'kairos-edge-scout-us'
);

select cron.schedule(
  'kairos-edge-scout-us', '30 22 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/edge-scout?market=us&universe=liquid&maxSymbols=50', '{}'::jsonb, 'POST', 290000)$$
);
