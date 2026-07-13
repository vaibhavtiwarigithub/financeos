-- 169: live_performance — real daily equity curve per live (Robinhood) account.
--
-- WHY: the live benchmark chart (portfolio vs VOO, per account) needs a daily
-- equity time-series, exactly like paper_performance(date, market, nav, bench_nav)
-- backs the paper chart. Robinhood's MCP exposes NO account-value history
-- (get_equity_historicals is per-SYMBOL OHLC; get_portfolio is current only), so
-- we cannot backfill a true curve — we accrue it forward: each account-snapshot
-- refresh upserts one row/account/day with real broker equity + that day's VOO
-- close. Until >=2 real days exist, the read API falls back to a labeled
-- constant-holdings estimate. This table is the durable, honest source.
--
-- Keyed by (account_id, date): one row per account per calendar day. equity is
-- the broker account value (USD); bench_nav is VOO's close the same day so the
-- chart rebases both to % per window. Service-role writes; authenticated reads
-- (mirrors paper_performance / migration 005).

create table if not exists public.live_performance (
  account_id text        not null,
  date       date        not null,
  equity     numeric,
  bench_nav  numeric,
  created_at timestamptz not null default now(),
  primary key (account_id, date)
);

alter table public.live_performance enable row level security;

-- Authenticated (owner) may read; writes come from the service client which
-- bypasses RLS, so no insert/update policy is granted to app roles.
drop policy if exists live_performance_authenticated_read on public.live_performance;
create policy live_performance_authenticated_read
  on public.live_performance
  for select
  using (auth.role() = 'authenticated');

create index if not exists live_performance_date_idx on public.live_performance (date);
