-- Operational health for scheduled Upgrade Path evidence producers.
-- This is intentionally separate from immutable attribution/snapshot ledgers:
-- it records that a collector ran, and whether it was blocked or failed.
create table if not exists public.upgrade_path_producer_runs (
  id uuid primary key default gen_random_uuid(),
  program_id text not null,
  market text not null check (market in ('us', 'india')),
  run_key text not null unique,
  trigger_source text not null check (trigger_source in ('cron_authenticated', 'owner_manual')),
  status text not null check (status in ('running', 'collected', 'blocked', 'error')),
  expected_session date,
  observed_session date,
  code_version text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  blockers text[] not null default '{}',
  details jsonb not null default '{}'::jsonb,
  constraint upgrade_path_producer_runs_finish_check check (
    (status = 'running' and finished_at is null)
    or (status <> 'running' and finished_at is not null)
  )
);

create index if not exists upgrade_path_producer_runs_latest_idx
  on public.upgrade_path_producer_runs (market, program_id, started_at desc, id desc);

alter table public.upgrade_path_producer_runs enable row level security;
revoke all on public.upgrade_path_producer_runs from public, anon, authenticated;
grant select on public.upgrade_path_producer_runs to authenticated;
grant select, insert, update on public.upgrade_path_producer_runs to service_role;

drop policy if exists upgrade_path_producer_runs_owner_read on public.upgrade_path_producer_runs;
create policy upgrade_path_producer_runs_owner_read
  on public.upgrade_path_producer_runs for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

-- A fixed recent-row limit can silently omit the latest invocation for a
-- low-frequency program after other producers become busy. Return one row per
-- program for the requested market instead of making the API infer recency.
create or replace function public.get_upgrade_path_producer_runs_latest(p_market text)
returns setof public.upgrade_path_producer_runs
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select distinct on (program_id) *
  from public.upgrade_path_producer_runs
  where market = p_market
  order by program_id, started_at desc, id desc;
$$;

revoke all on function public.get_upgrade_path_producer_runs_latest(text) from public, anon, authenticated;
grant execute on function public.get_upgrade_path_producer_runs_latest(text) to service_role;

comment on table public.upgrade_path_producer_runs is
  'Mutable operational run health for scheduled Upgrade Path producers; not a performance result and never read by trading paths.';
