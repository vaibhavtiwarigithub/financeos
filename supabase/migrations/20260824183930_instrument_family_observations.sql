-- Instrument-aware scoring P0/P1: immutable, measurement-only family evidence.
-- No paper/live/scoring path reads this table. It exists to validate challengers
-- on homogeneous market x family x setup cohorts before any owner promotion.

create table if not exists public.instrument_family_observations (
  id                 bigserial primary key,
  observation_id     bigint not null references public.decision_observations(id),
  created_at         timestamptz not null default now(),
  market             text not null check (market in ('us', 'india')),
  symbol             text not null,
  instrument_family  text not null,
  exposure_id        text not null,
  taxonomy_version   text not null,
  feature_version    text not null,
  benchmark_symbol   text,
  features           jsonb not null check (jsonb_typeof(features) = 'object'),
  lifecycle          text not null default 'measure_only'
    check (lifecycle = 'measure_only'),
  unique (observation_id)
);

create index if not exists instrument_family_market_family_created_idx
  on public.instrument_family_observations (market, instrument_family, created_at desc);
create index if not exists instrument_family_exposure_created_idx
  on public.instrument_family_observations (market, exposure_id, created_at desc);

create or replace function public.instrument_family_observations_immutable()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception 'instrument_family_observations is append-only (evidence)';
end;
$$;

drop trigger if exists instrument_family_observations_no_mutation
  on public.instrument_family_observations;
create trigger instrument_family_observations_no_mutation
  before update or delete on public.instrument_family_observations
  for each row execute function public.instrument_family_observations_immutable();

alter table public.instrument_family_observations enable row level security;

drop policy if exists instrument_family_observations_authenticated_read
  on public.instrument_family_observations;
create policy instrument_family_observations_authenticated_read
  on public.instrument_family_observations for select to authenticated using (true);

revoke insert, update, delete, truncate on public.instrument_family_observations
  from anon, authenticated;

comment on table public.instrument_family_observations is
  'Append-only, measure-only instrument-family evidence. Never an order authorization source.';
