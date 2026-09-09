begin;

create table if not exists public.score_price_divergence_runs (
  id uuid primary key default gen_random_uuid(),
  market text not null check (market in ('us','india')),
  run_session date not null,
  policy_version text not null default 'score-price-divergence-v1',
  input_observations integer not null check (input_observations >= 0),
  canonical_sessions integer not null check (canonical_sessions >= 0),
  events_detected integer not null check (events_detected >= 0),
  primary_events_detected integer not null check (primary_events_detected >= 0),
  exclusions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (market, run_session, policy_version)
);

create table if not exists public.score_price_divergence_events (
  id uuid primary key default gen_random_uuid(),
  policy_version text not null default 'score-price-divergence-v1',
  market text not null check (market in ('us','india')),
  symbol text not null,
  window_sessions integer not null check (window_sessions in (3,5)),
  start_observation_id bigint not null references public.decision_observations(id),
  end_observation_id bigint not null references public.decision_observations(id),
  start_session date not null,
  end_session date not null,
  direction text not null check (direction in ('falling_score_rising_price','rising_score_falling_price')),
  score_delta numeric not null,
  price_return_pct numeric not null,
  dimension_deltas jsonb not null default '{}'::jsonb,
  score_source text not null,
  scoring_version text not null,
  availability_fingerprint text not null,
  weights_fingerprint text not null,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (policy_version, market, symbol, window_sessions, start_observation_id, end_observation_id),
  constraint score_price_divergence_primary_definition check (
    not is_primary or (
      window_sessions = 5
      and abs(score_delta) >= 5
      and abs(price_return_pct) >= 2
    )
  )
);

create table if not exists public.score_price_divergence_outcomes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.score_price_divergence_events(id),
  horizon_days integer not null check (horizon_days in (5,10,20)),
  end_observation_id bigint not null references public.decision_observations(id),
  fwd_return numeric,
  benchmark_return numeric,
  benchmark_neutral_return numeric,
  max_adverse_excursion numeric,
  max_favorable_excursion numeric,
  matured_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (event_id, horizon_days)
);

create index if not exists score_price_divergence_events_market_session_idx
  on public.score_price_divergence_events (market, end_session desc);
create index if not exists score_price_divergence_outcomes_event_idx
  on public.score_price_divergence_outcomes (event_id, horizon_days);

alter table public.score_price_divergence_runs enable row level security;
alter table public.score_price_divergence_events enable row level security;
alter table public.score_price_divergence_outcomes enable row level security;

create policy score_price_divergence_runs_owner_read on public.score_price_divergence_runs
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy score_price_divergence_events_owner_read on public.score_price_divergence_events
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
create policy score_price_divergence_outcomes_owner_read on public.score_price_divergence_outcomes
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');

revoke all on public.score_price_divergence_runs from public, anon, authenticated;
revoke all on public.score_price_divergence_events from public, anon, authenticated;
revoke all on public.score_price_divergence_outcomes from public, anon, authenticated;
grant select on public.score_price_divergence_runs, public.score_price_divergence_events, public.score_price_divergence_outcomes to authenticated;
grant select, insert on public.score_price_divergence_runs, public.score_price_divergence_events, public.score_price_divergence_outcomes to service_role;

create or replace function public.score_price_divergence_no_mutate()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'score-price divergence evidence is append-only';
end;
$$;
revoke all on function public.score_price_divergence_no_mutate() from public, anon, authenticated;

create trigger score_price_divergence_runs_no_mutate before update or delete on public.score_price_divergence_runs
  for each row execute function public.score_price_divergence_no_mutate();
create trigger score_price_divergence_events_no_mutate before update or delete on public.score_price_divergence_events
  for each row execute function public.score_price_divergence_no_mutate();
create trigger score_price_divergence_outcomes_no_mutate before update or delete on public.score_price_divergence_outcomes
  for each row execute function public.score_price_divergence_no_mutate();
create trigger score_price_divergence_runs_no_truncate before truncate on public.score_price_divergence_runs
  for each statement execute function public.score_price_divergence_no_mutate();
create trigger score_price_divergence_events_no_truncate before truncate on public.score_price_divergence_events
  for each statement execute function public.score_price_divergence_no_mutate();
create trigger score_price_divergence_outcomes_no_truncate before truncate on public.score_price_divergence_outcomes
  for each statement execute function public.score_price_divergence_no_mutate();

comment on table public.score_price_divergence_events is
  'Immutable measure-only score/price divergence events. No scoring or trading path may consume this table.';

do $$ begin
  perform cron.unschedule('kairos-rescore');
exception when others then null;
end $$;
do $$ begin
  perform cron.unschedule('kairos-score-price-divergence-us');
exception when others then null;
end $$;
do $$ begin
  perform cron.unschedule('kairos-score-price-divergence-india');
exception when others then null;
end $$;

select cron.schedule(
  'kairos-score-price-divergence-us', '20 22 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/score-price-divergence?market=us', '{}'::jsonb, 'POST', 60000)$$
);
select cron.schedule(
  'kairos-score-price-divergence-india', '25 22 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/score-price-divergence?market=india', '{}'::jsonb, 'POST', 60000)$$
);

commit;
