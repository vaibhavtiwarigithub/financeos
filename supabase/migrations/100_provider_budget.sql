-- Generic per-provider daily call counter. Generalizes av_budget (090) so each
-- external data provider (alpha_vantage, financialdatasets, massive, finnhub,
-- fmp, eodhd, twelvedata, upstox, fred) has its OWN daily budget instead of all
-- sharing the single Alpha Vantage 25/day counter. Before this, a
-- FinancialDatasets snapshot routed through avCachedFetch incremented av_budget
-- and consumed an Alpha Vantage slot it had no business touching.
--
-- The response cache itself stays in av_cache (keyed by a globally-unique
-- cache_key that is provider-prefixed) — only the BUDGET is split here.

create table if not exists provider_budget (
  provider   text not null,
  cache_date date not null,
  calls      integer not null default 0,
  primary key (provider, cache_date)
);

-- Atomic increment + read-back in one round trip, race-safe under concurrency.
create or replace function provider_budget_increment(p_provider text, p_date date)
returns integer
language plpgsql
as $$
declare
  new_calls integer;
begin
  insert into provider_budget (provider, cache_date, calls) values (p_provider, p_date, 1)
  on conflict (provider, cache_date) do update set calls = provider_budget.calls + 1
  returning calls into new_calls;
  return new_calls;
end;
$$;

alter table provider_budget enable row level security;
revoke all on table provider_budget from anon, authenticated;

-- 7-day rolling average per provider, for the Settings Data Providers capacity
-- dashboard ("where is the ceiling"). A plain view so the panel is one select.
create or replace view provider_budget_7d as
select
  provider,
  round(avg(calls))::int              as avg_calls_7d,
  max(calls)                          as peak_calls_7d,
  count(*)                            as days_seen
from provider_budget
where cache_date >= (current_date - interval '7 days')
group by provider;
