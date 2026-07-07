-- Daily Alpha Vantage real-call counter. Free tier = 25/day. avCachedFetch
-- increments this only when it spends a real network call (cache hits/fallbacks
-- don't count). When the day's count reaches the ceiling, avCachedFetch stops
-- spending calls and serves last-known cached payloads instead.
create table if not exists av_budget (
  cache_date date primary key,
  calls integer not null default 0
);

-- Atomic increment + read-back in one round trip, race-safe under concurrency.
create or replace function av_budget_increment(p_date date)
returns integer
language plpgsql
as $$
declare
  new_calls integer;
begin
  insert into av_budget (cache_date, calls) values (p_date, 1)
  on conflict (cache_date) do update set calls = av_budget.calls + 1
  returning calls into new_calls;
  return new_calls;
end;
$$;

alter table av_budget enable row level security;
revoke all on table av_budget from anon, authenticated;
