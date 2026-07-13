-- Benchmark alpha scorecard + capital rotation shadow ledger.
--
-- Phase 1 benchmark-alpha is measurement-only: no learner mutation, no paper
-- fills, no live orders. Capital rotation ships P0 shadow-only: it records what
-- would have been considered on insufficient_cash, but never sells or buys.

-- Live performance provenance. Existing rows are US/USD broker-equity snapshots;
-- broker is backfilled from live_account_snapshots when possible.
alter table public.live_performance
  add column if not exists market text,
  add column if not exists currency text,
  add column if not exists broker text,
  add column if not exists book_scope text;

update public.live_performance lp
set
  broker = coalesce(
    lp.broker,
    (
      select las.broker
      from public.live_account_snapshots las
      where las.account_id = lp.account_id
      order by las.captured_at desc nulls last
      limit 1
    ),
    'robinhood'
  ),
  market = coalesce(lp.market, 'us'),
  currency = coalesce(lp.currency, 'USD'),
  book_scope = coalesce(lp.book_scope, 'all_live_accounts')
where lp.market is null
   or lp.currency is null
   or lp.broker is null
   or lp.book_scope is null;

create index if not exists live_performance_scope_date_idx
  on public.live_performance (market, currency, book_scope, date);

-- Benchmark configuration.
create table if not exists public.benchmarks (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us', 'india')),
  label text not null,
  kind text not null default 'single' check (kind in ('single', 'blend')),
  symbol text,
  provider_symbol text,
  currency text not null check (currency in ('USD', 'INR')),
  price_provider text not null,
  is_primary boolean not null default false,
  enabled boolean not null default true,
  weights jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint benchmarks_single_symbol check (
    (kind = 'single' and provider_symbol is not null)
    or (kind = 'blend' and weights is not null)
  )
);

create unique index if not exists benchmarks_one_enabled_primary_per_market
  on public.benchmarks (market)
  where is_primary = true and enabled = true;

create index if not exists benchmarks_market_enabled_idx
  on public.benchmarks (market, enabled);

alter table public.benchmarks enable row level security;

drop policy if exists benchmarks_owner_read on public.benchmarks;
create policy benchmarks_owner_read
  on public.benchmarks
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

-- Benchmark component observations. Service routes fill this from existing
-- paper/live benchmark ledgers or provider adapters; missing observations remain
-- visible through benchmark_scorecard status rows.
create table if not exists public.benchmark_price_observations (
  benchmark_id uuid not null references public.benchmarks(id),
  component_symbol text not null,
  date date not null,
  close numeric,
  currency text not null check (currency in ('USD', 'INR')),
  provider text not null,
  source_status text not null check (source_status in ('ok', 'missing', 'provider_error', 'unpriceable')),
  error text,
  created_at timestamptz not null default now(),
  primary key (benchmark_id, component_symbol, date)
);

create index if not exists benchmark_price_observations_date_idx
  on public.benchmark_price_observations (date desc);

alter table public.benchmark_price_observations enable row level security;

drop policy if exists benchmark_price_observations_owner_read on public.benchmark_price_observations;
create policy benchmark_price_observations_owner_read
  on public.benchmark_price_observations
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

-- Materialized scorecard rows.
create table if not exists public.benchmark_scorecard (
  market text not null check (market in ('us', 'india')),
  currency text not null check (currency in ('USD', 'INR')),
  book text not null check (book in ('paper', 'live')),
  book_scope text not null,
  benchmark_id uuid not null references public.benchmarks(id),
  benchmark_symbol text not null,
  is_primary_snapshot boolean not null,
  horizon text not null check (horizon in ('1W', '1M', '3M', 'YTD', '1Y')),
  as_of date not null,
  window_start date,
  window_end date,
  portfolio_return_pct numeric,
  bench_return_pct numeric,
  excess_return_pct numeric,
  daily_excess_mean_pct numeric,
  tracking_error_daily_pct numeric,
  info_ratio numeric,
  n_observations int not null default 0,
  n_return_days int not null default 0,
  coverage_pct numeric,
  confidence text not null check (confidence in ('insufficient', 'low', 'medium', 'high')),
  status text not null check (status in ('ok', 'insufficient_data', 'benchmark_unpriceable', 'book_series_missing', 'currency_mismatch', 'stale_series')),
  missing_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (market, currency, book, book_scope, benchmark_id, horizon, as_of)
);

create index if not exists benchmark_scorecard_scope_asof_idx
  on public.benchmark_scorecard (market, book, book_scope, as_of desc);

create index if not exists benchmark_scorecard_benchmark_asof_idx
  on public.benchmark_scorecard (benchmark_id, as_of desc);

alter table public.benchmark_scorecard enable row level security;

drop policy if exists benchmark_scorecard_owner_read on public.benchmark_scorecard;
create policy benchmark_scorecard_owner_read
  on public.benchmark_scorecard
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

-- Idempotent primary benchmark seed.
insert into public.benchmarks
  (market, label, kind, symbol, provider_symbol, currency, price_provider, is_primary, enabled)
values
  ('us', 'VOO', 'single', 'VOO', 'VOO', 'USD', 'paper_performance_or_massive', true, true)
on conflict do nothing;

insert into public.benchmarks
  (market, label, kind, symbol, provider_symbol, currency, price_provider, is_primary, enabled)
values
  ('india', 'NIFTY 50', 'single', '^NSEI', '^NSEI', 'INR', 'paper_performance_or_yahoo_india', true, true)
on conflict do nothing;

-- Capital rotation configuration. Shadow is enabled so the app can measure
-- opportunity cost. Paper execution and live proposals stay disabled.
create table if not exists public.rotation_config (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us', 'india')),
  book_type text not null check (book_type in ('paper', 'live')),
  rotation_shadow_enabled boolean not null default true,
  rotation_paper_execute_enabled boolean not null default false,
  rotation_live_proposals_enabled boolean not null default false,
  rotation_allow_score_only_paper boolean not null default false,
  rotation_margin_score numeric not null default 12,
  rotation_persistence_runs int not null default 2,
  rotation_cooldown_days int not null default 5,
  max_rotations_per_run int not null default 1,
  max_rotations_per_day int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (market, book_type)
);

alter table public.rotation_config enable row level security;

drop policy if exists rotation_config_owner_read on public.rotation_config;
create policy rotation_config_owner_read
  on public.rotation_config
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

insert into public.rotation_config (market, book_type)
values ('us', 'paper'), ('india', 'paper'), ('us', 'live'), ('india', 'live')
on conflict (market, book_type) do nothing;

-- Capital rotation shadow/evaluation ledger. P0 writes rejected/planned shadow
-- decisions only. It is append-only so duplicate runs and learning labels are
-- reconstructable.
create table if not exists public.rotation_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  owner_user_id uuid,
  owner_email text not null default 'vterminater@gmail.com',
  market text not null check (market in ('us', 'india')),
  currency text not null check (currency in ('USD', 'INR')),
  book_type text not null check (book_type in ('paper', 'live')),
  account_id text,
  idempotency_key text not null unique,
  status text not null check (status in (
    'evaluated', 'rejected', 'planned', 'paper_executed',
    'live_sell_submitted', 'live_sell_confirmed', 'live_buy_submitted',
    'completed', 'aborted', 'needs_reconcile'
  )),
  candidate_symbol text not null,
  source_symbol text,
  candidate_signal_id uuid,
  source_position_id uuid,
  candidate_score numeric,
  source_score numeric,
  score_edge numeric,
  benchmark_id uuid references public.benchmarks(id),
  alpha_status text,
  candidate_alpha numeric,
  source_alpha numeric,
  alpha_edge numeric,
  sell_notional numeric,
  buy_notional numeric,
  turnover_consumed numeric,
  cost_model_json jsonb not null default '{}'::jsonb,
  tax_model_json jsonb not null default '{}'::jsonb,
  gate_results_json jsonb not null default '{}'::jsonb,
  audit_json jsonb not null default '{}'::jsonb,
  trade_proposal_id bigint,
  paper_trade_ids jsonb
);

create index if not exists rotation_events_scope_created_idx
  on public.rotation_events (market, book_type, created_at desc);

create index if not exists rotation_events_candidate_idx
  on public.rotation_events (candidate_symbol, market, created_at desc);

alter table public.rotation_events enable row level security;

drop policy if exists rotation_events_owner_read on public.rotation_events;
create policy rotation_events_owner_read
  on public.rotation_events
  for select
  to authenticated
  using (((select auth.jwt()) ->> 'email') = owner_email);

create or replace function public.block_rotation_events_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'rotation_events is append-only';
end;
$$;

drop trigger if exists rotation_events_block_mutation on public.rotation_events;
create trigger rotation_events_block_mutation
  before update or delete on public.rotation_events
  for each row execute function public.block_rotation_events_mutation();

revoke all on table public.benchmarks from anon, authenticated;
revoke all on table public.benchmark_price_observations from anon, authenticated;
revoke all on table public.benchmark_scorecard from anon, authenticated;
revoke all on table public.rotation_config from anon, authenticated;
revoke all on table public.rotation_events from anon, authenticated;
grant select on table public.benchmarks to authenticated;
grant select on table public.benchmark_price_observations to authenticated;
grant select on table public.benchmark_scorecard to authenticated;
grant select on table public.rotation_config to authenticated;
grant select on table public.rotation_events to authenticated;

-- Cloud schedule: after the daily NAV snapshot and label maturation, roll up the
-- benchmark scorecard. Guarded for local/dev databases without pg_cron.
do $outer$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is not null then
    begin
      perform cron.unschedule('kairos-benchmark-scorecard');
    exception when others then null;
    end;
    perform cron.schedule(
      'kairos-benchmark-scorecard',
      '15 22 * * 1-5',
      $job$select kairos_call_agent('/api/agents/benchmark-scorecard', '{}'::jsonb, 'POST', 70000)$job$
    );
  end if;
end $outer$;
