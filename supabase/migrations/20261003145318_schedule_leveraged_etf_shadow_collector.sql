-- Remote version 20261003145318; applied through Supabase MCP (project dionkikgdmlaotvtbnfr), job verified active.
-- The L1 leveraged-ETF shadow collector only records inside 11:00-11:14 ET but was scheduled solely in
-- vercel.json, where Hobby fires a cron at an unspecified minute inside the hour: it never hit the window and
-- leveraged_etf_shadow_observations has 0 rows. Minute-precise pg_cron job at :03 (both UTC hours; the route's own
-- ET window check makes the off-season hour a logged no-op). Measure-only: no order, score, flag change.
begin;
do $$ begin perform cron.unschedule('kairos-leveraged-etf-shadow'); exception when others then null; end $$;
select cron.schedule('kairos-leveraged-etf-shadow', '3 15,16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/leveraged-etf-shadow/collect', '{}'::jsonb, 'POST', 58000)$$);
commit;
