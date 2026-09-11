begin;

create table if not exists public.score_exit_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  as_of_date date not null,
  market text not null check (market in ('us','india')),
  horizon_days integer not null check (horizon_days in (2,5,10,20)),
  policy_version text not null,
  input_fingerprint text not null check (length(input_fingerprint) = 64),
  observation_count integer not null check (observation_count >= 0),
  distinct_session_count integer not null check (distinct_session_count >= 0),
  effective_observations numeric not null check (effective_observations >= 0),
  status text not null check (status in ('insufficient_evidence','measured_descriptive','data_degraded')),
  results jsonb not null,
  created_at timestamptz not null default now(),
  unique (as_of_date, market, horizon_days, policy_version)
);

alter table public.score_exit_shadow_runs enable row level security;
create policy score_exit_shadow_runs_owner_read on public.score_exit_shadow_runs
  for select to authenticated using (((select auth.jwt()) ->> 'email') = 'vterminater@gmail.com');
revoke all on public.score_exit_shadow_runs from public, anon, authenticated;
grant select on public.score_exit_shadow_runs to authenticated;
grant select, insert on public.score_exit_shadow_runs to service_role;

create or replace function public.score_exit_shadow_no_mutate()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'score-exit shadow evidence is append-only';
end;
$$;
revoke all on function public.score_exit_shadow_no_mutate() from public, anon, authenticated;
create trigger score_exit_shadow_runs_no_mutate before update or delete on public.score_exit_shadow_runs
  for each row execute function public.score_exit_shadow_no_mutate();
create trigger score_exit_shadow_runs_no_truncate before truncate on public.score_exit_shadow_runs
  for each statement execute function public.score_exit_shadow_no_mutate();

comment on table public.score_exit_shadow_runs is
  'Immutable holding-score exit counterfactuals. Measure-only; no score, position, exit, order or broker path may consume this table.';

do $$ begin perform cron.unschedule('kairos-score-exit-shadow-us'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('kairos-score-exit-shadow-india'); exception when others then null; end $$;
select cron.schedule('kairos-score-exit-shadow-us', '35 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/score-exit-shadow?market=us', '{}'::jsonb, 'POST', 60000)$$);
select cron.schedule('kairos-score-exit-shadow-india', '40 23 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/score-exit-shadow?market=india', '{}'::jsonb, 'POST', 60000)$$);

commit;
