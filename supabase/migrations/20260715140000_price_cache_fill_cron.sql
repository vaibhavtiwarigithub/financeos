-- Markets price-cache daily fill — schedule.
--
-- Pre-fills `price_cache` with the whole Markets ETF universe (regime proxies,
-- the 11 sector XLs, and the leveraged sentiment pairs) once per weekday,
-- pre-market, so the Markets tiles read a warm cache instead of each bursting
-- Massive's ~5/min free tier on page load. The fill uses ONE grouped-daily
-- Massive call (all US tickers, filtered to our universe), so it costs a single
-- request. Display data only — never on the money/scoring path.
--
-- Two ticks (13:25 + 13:45 UTC, both before the 14:00 UTC morning briefing) for
-- resilience: the job is idempotent (upsert by symbol+date, and it skips when
-- the most-recent session is already cached), so the second tick is a no-op once
-- the first has filled. Times are UTC assuming EDT — shift 1h at the Nov change,
-- consistent with the other kairos-* jobs.

do $$
declare j text;
begin
  foreach j in array array['kairos-price-cache-fill','kairos-price-cache-fill-retry']
  loop
    begin
      perform cron.unschedule(j);
    exception when others then null;
    end;
  end loop;
end $$;

select cron.schedule('kairos-price-cache-fill', '25 13 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/price-cache-fill', '{}'::jsonb, 'POST', 65000)$$);

select cron.schedule('kairos-price-cache-fill-retry', '45 13 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/price-cache-fill', '{}'::jsonb, 'POST', 65000)$$);
