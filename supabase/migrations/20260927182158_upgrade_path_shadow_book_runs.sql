-- Append-only daily snapshots for isolated Upgrade Path shadow books.
-- These snapshots are a collection/audit ledger, not an execution ledger.
-- No app trading path reads this table.

create table if not exists public.upgrade_path_shadow_book_runs (
  id uuid primary key default gen_random_uuid(),
  program_id text not null,
  market text not null check (market in ('us', 'india')),
  program_version text not null,
  baseline_version text not null,
  session_date date not null,
  window_start date not null,
  status text not null check (status = 'captured'),
  baseline_initial_state jsonb not null,
  variant_initial_state jsonb not null,
  baseline_state jsonb not null,
  variant_state jsonb not null,
  initial_nav numeric not null check (initial_nav > 0),
  benchmark_initial_close numeric not null check (benchmark_initial_close > 0),
  baseline_nav numeric not null check (baseline_nav > 0),
  variant_nav numeric not null check (variant_nav > 0),
  benchmark_nav numeric not null check (benchmark_nav > 0),
  baseline_cumulative_return_pct numeric not null,
  variant_cumulative_return_pct numeric not null,
  benchmark_cumulative_return_pct numeric not null,
  net_incremental_return_pct numeric not null,
  benchmark_relative_incremental_return_pct numeric not null,
  baseline_drawdown_pct numeric not null,
  variant_drawdown_pct numeric not null,
  turnover_pct numeric not null check (turnover_pct >= 0),
  independent_blocks integer not null default 0 check (independent_blocks >= 0),
  matched_population_hash text not null,
  input_snapshot_hash text not null,
  cost_model_version text not null,
  point_in_time_inputs jsonb not null default '{}'::jsonb,
  blockers text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (program_id, market, program_version, baseline_version, session_date),
  check (session_date >= window_start),
  check (abs(baseline_cumulative_return_pct - ((baseline_nav / initial_nav - 1) * 100)) <= 0.000001),
  check (abs(variant_cumulative_return_pct - ((variant_nav / initial_nav - 1) * 100)) <= 0.000001),
  check (abs(benchmark_cumulative_return_pct - ((benchmark_nav / benchmark_initial_close - 1) * 100)) <= 0.000001),
  check (abs((variant_cumulative_return_pct - baseline_cumulative_return_pct) - net_incremental_return_pct) <= 0.000001),
  check (abs(net_incremental_return_pct - benchmark_relative_incremental_return_pct) <= 0.000001)
);

create index if not exists upgrade_path_shadow_book_runs_lookup_idx
  on public.upgrade_path_shadow_book_runs (program_id, market, session_date desc);

alter table public.upgrade_path_shadow_book_runs enable row level security;
revoke all on public.upgrade_path_shadow_book_runs from public, anon, authenticated;
grant select on public.upgrade_path_shadow_book_runs to authenticated;
grant select, insert on public.upgrade_path_shadow_book_runs to service_role;

drop policy if exists upgrade_path_shadow_book_runs_owner_read on public.upgrade_path_shadow_book_runs;
create policy upgrade_path_shadow_book_runs_owner_read
  on public.upgrade_path_shadow_book_runs for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

create or replace function public.reject_upgrade_path_shadow_book_mutation()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'upgrade_path_shadow_book_runs is append-only';
end;
$$;

revoke all on function public.reject_upgrade_path_shadow_book_mutation() from public, anon, authenticated;
drop trigger if exists upgrade_path_shadow_book_runs_append_only on public.upgrade_path_shadow_book_runs;
create trigger upgrade_path_shadow_book_runs_append_only
  before update or delete on public.upgrade_path_shadow_book_runs
  for each row execute function public.reject_upgrade_path_shadow_book_mutation();

comment on table public.upgrade_path_shadow_book_runs is
  'Append-only daily matched shadow-book states and P&L snapshots. Evidence only; never read by paper/live execution.';

create or replace function public.get_upgrade_path_shadow_book_latest(p_market text)
returns setof public.upgrade_path_shadow_book_runs
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select distinct on (program_id) *
  from public.upgrade_path_shadow_book_runs
  where market = p_market
  order by program_id, session_date desc, created_at desc;
$$;

revoke all on function public.get_upgrade_path_shadow_book_latest(text) from public, anon, authenticated;
grant execute on function public.get_upgrade_path_shadow_book_latest(text) to service_role;
