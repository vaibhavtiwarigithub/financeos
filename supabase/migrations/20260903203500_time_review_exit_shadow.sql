-- Time-review exit shadow v1. Forward-only, measure-only evidence.
--
-- The older horizon_extension_shadow ledger contains daily one-day-extension
-- counterfactuals. It is intentionally preserved. These two tables implement
-- the approved exact-horizon +5/+10-session trial without reinterpreting old
-- rows under a new policy.

begin;

create table if not exists public.time_review_exit_observations (
  id                              uuid primary key default gen_random_uuid(),
  policy_version                  text not null default 'time-review-v1',
  run_id                          text not null,
  idempotency_key                 text not null unique,
  observed_at                     timestamptz not null default now(),
  review_session                  date not null,
  market                          text not null check (market in ('us','india')),
  symbol                          text not null,
  position_id                     text not null,
  currency                        text not null,
  opened_at                       timestamptz not null,
  entry_price                     numeric not null check (entry_price > 0),
  review_price                    numeric not null check (review_price > 0),
  unrealized_return_pct           numeric not null,
  high_water_price                numeric not null check (high_water_price > 0),
  drawdown_from_high_pct          numeric not null check (drawdown_from_high_pct >= 0),
  effective_stop_price            numeric,
  initial_stop_distance_pct       numeric,
  resolved_horizon_days           integer not null check (resolved_horizon_days >= 1),
  candidate_extension_days        integer[] not null default array[5,10],
  score                           numeric,
  score_direction                 text,
  score_observed_at               timestamptz,
  score_fresh                     boolean not null,
  hold_threshold                  numeric not null,
  exit_threshold                  numeric not null,
  candidate_eligible              boolean not null,
  classification                  text not null check (classification in ('eligible','not_eligible')),
  failed_conditions               jsonb not null default '[]'::jsonb,
  replacement_candidate_available boolean,
  replacement_symbol              text,
  replacement_score               numeric,
  mandate_version                 integer,
  mandate_snapshot                jsonb,
  created_at                      timestamptz not null default now(),
  constraint time_review_exact_candidate_family
    check (candidate_extension_days = array[5,10]),
  constraint time_review_eligibility_consistent
    check (candidate_eligible = (classification = 'eligible')),
  constraint time_review_stop_distance_valid
    check (initial_stop_distance_pct is null or initial_stop_distance_pct >= 0)
);

create index if not exists time_review_exit_market_session_idx
  on public.time_review_exit_observations (market, review_session desc);
create index if not exists time_review_exit_position_idx
  on public.time_review_exit_observations (position_id, review_session desc);

create table if not exists public.time_review_exit_outcomes (
  id                              uuid primary key default gen_random_uuid(),
  review_id                       uuid not null references public.time_review_exit_observations(id),
  policy_version                  text not null,
  extension_days                  integer not null check (extension_days in (5,10)),
  matured_at                      timestamptz not null default now(),
  baseline_exit_session           date not null,
  baseline_exit_price             numeric not null check (baseline_exit_price > 0),
  baseline_total_return_pct       numeric not null,
  baseline_review_return_pct      numeric not null,
  candidate_exit_session          date not null,
  candidate_exit_price            numeric not null check (candidate_exit_price > 0),
  candidate_total_return_pct      numeric not null,
  candidate_review_return_pct     numeric not null,
  benchmark_return_pct            numeric,
  benchmark_relative_return_pct   numeric,
  incremental_vs_baseline_pct     numeric not null,
  max_favorable_excursion_pct     numeric not null,
  max_adverse_excursion_pct       numeric not null,
  mechanical_stop_hit             boolean not null,
  mechanical_stop_session         date,
  replacement_candidate_available boolean,
  estimated_incremental_cost_pct  numeric not null default 0,
  created_at                      timestamptz not null default now(),
  unique (review_id, policy_version, extension_days),
  constraint time_review_stop_session_consistent check (
    (mechanical_stop_hit and mechanical_stop_session is not null)
    or (not mechanical_stop_hit and mechanical_stop_session is null)
  )
);

create index if not exists time_review_outcomes_review_idx
  on public.time_review_exit_outcomes (review_id, extension_days);

alter table public.time_review_exit_observations enable row level security;
alter table public.time_review_exit_outcomes enable row level security;

drop policy if exists time_review_exit_observations_owner_read on public.time_review_exit_observations;
create policy time_review_exit_observations_owner_read
  on public.time_review_exit_observations for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

drop policy if exists time_review_exit_outcomes_owner_read on public.time_review_exit_outcomes;
create policy time_review_exit_outcomes_owner_read
  on public.time_review_exit_outcomes for select to authenticated
  using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on public.time_review_exit_observations from public, anon, authenticated;
revoke all on public.time_review_exit_outcomes from public, anon, authenticated;
grant select on public.time_review_exit_observations to authenticated;
grant select on public.time_review_exit_outcomes to authenticated;
grant select, insert on public.time_review_exit_observations to service_role;
grant select, insert on public.time_review_exit_outcomes to service_role;

create or replace function public.time_review_exit_no_mutate()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'time-review exit evidence is append-only';
end;
$$;

drop trigger if exists time_review_exit_observations_no_mutate on public.time_review_exit_observations;
create trigger time_review_exit_observations_no_mutate
  before update or delete on public.time_review_exit_observations
  for each row execute function public.time_review_exit_no_mutate();

drop trigger if exists time_review_exit_outcomes_no_mutate on public.time_review_exit_outcomes;
create trigger time_review_exit_outcomes_no_mutate
  before update or delete on public.time_review_exit_outcomes
  for each row execute function public.time_review_exit_no_mutate();

comment on table public.time_review_exit_observations is
  'Immutable exact-horizon observations for the measure-only +5/+10 time-review exit challenger.';
comment on table public.time_review_exit_outcomes is
  'Immutable matured candidate-vs-incumbent outcomes. No trading path may consume this table.';

commit;
