-- Exogenous-risk P0: record-only point-in-time evidence for future India
-- domestic macro and global-spillover research. Nothing on the score, paper,
-- live, exit, sizing, broker, or Router path reads these tables.

create table if not exists public.exogenous_observations (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us', 'india', 'global')),
  scope text not null check (scope in ('domestic', 'global_spillover')),
  series_key text not null check (series_key ~ '^[a-z0-9_.-]+$'),
  value numeric,
  unit text not null check (char_length(unit) between 1 and 48),
  observed_period text not null check (char_length(observed_period) between 1 and 64),
  published_at timestamptz not null,
  available_at timestamptz not null,
  source text not null check (char_length(source) between 1 and 64),
  source_url text not null check (source_url ~ '^https://'),
  source_revision text,
  payload_fingerprint text not null check (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  quality text not null check (quality in ('fresh', 'stale', 'partial', 'unavailable')),
  created_at timestamptz not null default now(),
  check (available_at >= published_at),
  check ((market = 'global') = (scope = 'global_spillover')),
  unique (market, series_key, available_at, payload_fingerprint)
);

create index if not exists exogenous_observations_market_series_available_idx
  on public.exogenous_observations (market, series_key, available_at desc);

create table if not exists public.market_regime_runs (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us', 'india')),
  domestic_state text not null check (domestic_state in ('supportive', 'neutral', 'adverse', 'unavailable')),
  global_spillover_state text not null check (global_spillover_state in ('supportive', 'neutral', 'adverse', 'unavailable')),
  formula_version text not null check (char_length(formula_version) between 1 and 64),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  computed_at timestamptz not null default now(),
  eligible_input_count integer not null check (eligible_input_count >= 0),
  created_at timestamptz not null default now(),
  unique (market, formula_version, input_fingerprint)
);

create index if not exists market_regime_runs_market_computed_idx
  on public.market_regime_runs (market, computed_at desc);

create or replace function public.exogenous_risk_append_only()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'exogenous-risk evidence is append-only';
end;
$$;

revoke all on function public.exogenous_risk_append_only() from public, anon, authenticated;

drop trigger if exists exogenous_observations_no_mutation on public.exogenous_observations;
create trigger exogenous_observations_no_mutation
  before update or delete on public.exogenous_observations
  for each row execute function public.exogenous_risk_append_only();

drop trigger if exists market_regime_runs_no_mutation on public.market_regime_runs;
create trigger market_regime_runs_no_mutation
  before update or delete on public.market_regime_runs
  for each row execute function public.exogenous_risk_append_only();

alter table public.exogenous_observations enable row level security;
alter table public.market_regime_runs enable row level security;
revoke all on public.exogenous_observations, public.market_regime_runs from anon;
revoke all on public.exogenous_observations, public.market_regime_runs from authenticated;

drop policy if exists exogenous_observations_service_all on public.exogenous_observations;
create policy exogenous_observations_service_all on public.exogenous_observations
  for all to service_role using (true) with check (true);
drop policy if exists exogenous_observations_owner_read on public.exogenous_observations;
create policy exogenous_observations_owner_read on public.exogenous_observations
  for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

drop policy if exists market_regime_runs_service_all on public.market_regime_runs;
create policy market_regime_runs_service_all on public.market_regime_runs
  for all to service_role using (true) with check (true);
drop policy if exists market_regime_runs_owner_read on public.market_regime_runs;
create policy market_regime_runs_owner_read on public.market_regime_runs
  for select to authenticated using ((select auth.jwt() ->> 'email') = 'vterminater@gmail.com');

-- The India macro narrative path has refused this market before any LLM call or
-- write since 2026-07-17. Remove the obsolete cron so it no longer wakes Vercel.
do $$
begin
  begin perform cron.unschedule('kairos-macro-read-india'); exception when others then null; end;
end;
$$;

comment on table public.exogenous_observations is
  'Append-only record-only macro/global-spillover evidence. No score, order, paper, live, exit, sizing, broker, or Router consumer.';
comment on table public.market_regime_runs is
  'Append-only deterministic market-local regime shadow. No decision consumer until separately approved.';
