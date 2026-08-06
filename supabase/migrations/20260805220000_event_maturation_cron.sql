-- Event ledger step 2 — maturation schedule.
--
-- Computes forward paths (1/5/21 sessions) for recorded market events into
-- market_event_outcomes. MEASUREMENT ONLY: no score, eligibility, sizing,
-- entry, exit, promotion or broker path reads either table.
--
-- Daily rather than weekly even though events arrive roughly monthly. The job
-- is idempotent (it skips (event, horizon, benchmark) triples that already
-- exist) and costs ~2s for the whole ledger, while a weekly tick would leave a
-- freshly elapsed 21-session horizon unmatured for up to 7 days — long enough
-- for a base-rate read to under-count its own n.
--
-- 16:10 UTC is after the US session referenced by the newest possible horizon
-- has settled and clear of the 13:25/13:45 price-cache ticks and the 14:00
-- briefing. Weekdays only: no session elapses at a weekend, so a weekend run
-- could only repeat the Friday result.

do $$
begin
  begin
    perform cron.unschedule('kairos-event-maturation');
  exception when others then null;
  end;
end $$;

select cron.schedule('kairos-event-maturation', '10 16 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/event-maturation', '{}'::jsonb, 'POST', 65000)$$);
