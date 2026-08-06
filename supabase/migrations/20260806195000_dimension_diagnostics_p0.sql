-- Governed Dimension Diagnostics P0: append-only, market-local measurement.
-- These rows are diagnostic indexes over existing decision/label evidence. They
-- have no scorer, strategy, paper, live, exit, sizing, proposal or broker reader.

create table if not exists public.dimension_diagnostic_runs (
  id bigserial primary key,
  market text not null check (market in ('us', 'india')),
  analysis_plan_version text not null,
  as_of_date date not null,
  horizon_days integer not null check (horizon_days in (2, 5, 10, 20)),
  code_version text,
  input_observation_count integer not null check (input_observation_count >= 0),
  mature_label_count integer not null check (mature_label_count >= 0),
  distinct_session_count integer not null check (distinct_session_count >= 0),
  input_fingerprint text not null,
  status text not null check (status in ('insufficient_evidence', 'measured')),
  created_at timestamptz not null default now(),
  unique (market, analysis_plan_version, as_of_date, horizon_days)
);

create table if not exists public.dimension_diagnostic_findings (
  id bigserial primary key,
  diagnostic_run_id bigint not null references public.dimension_diagnostic_runs(id) on delete restrict,
  market text not null check (market in ('us', 'india')),
  subject_type text not null check (subject_type in ('dimension', 'agent', 'collaboration')),
  subject_key text not null,
  finding_type text not null check (finding_type in ('availability', 'predictive', 'contribution', 'collaboration')),
  classification text not null,
  metrics jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (diagnostic_run_id, subject_type, subject_key, finding_type)
);

create index if not exists dimension_diagnostic_runs_market_created_idx
  on public.dimension_diagnostic_runs (market, created_at desc);
create index if not exists dimension_diagnostic_findings_run_idx
  on public.dimension_diagnostic_findings (diagnostic_run_id, subject_type, finding_type);

alter table public.dimension_diagnostic_runs enable row level security;
alter table public.dimension_diagnostic_findings enable row level security;
revoke all on public.dimension_diagnostic_runs from public, anon, authenticated;
revoke all on public.dimension_diagnostic_findings from public, anon, authenticated;
grant all on public.dimension_diagnostic_runs, public.dimension_diagnostic_findings to service_role;
grant usage, select on sequence public.dimension_diagnostic_runs_id_seq, public.dimension_diagnostic_findings_id_seq to service_role;

create or replace function public.dimension_diagnostics_block_mutation()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'dimension diagnostics are append-only';
end;
$$;
revoke all on function public.dimension_diagnostics_block_mutation() from public;

drop trigger if exists dimension_diagnostic_runs_no_mutation on public.dimension_diagnostic_runs;
create trigger dimension_diagnostic_runs_no_mutation
  before update or delete on public.dimension_diagnostic_runs
  for each row execute function public.dimension_diagnostics_block_mutation();
drop trigger if exists dimension_diagnostic_findings_no_mutation on public.dimension_diagnostic_findings;
create trigger dimension_diagnostic_findings_no_mutation
  before update or delete on public.dimension_diagnostic_findings
  for each row execute function public.dimension_diagnostics_block_mutation();

do $$
begin
  if exists (select 1 from cron.job where jobname = 'kairos-dimension-diagnostics-us') then
    perform cron.unschedule('kairos-dimension-diagnostics-us');
  end if;
  if exists (select 1 from cron.job where jobname = 'kairos-dimension-diagnostics-india') then
    perform cron.unschedule('kairos-dimension-diagnostics-india');
  end if;
end;
$$;

select cron.schedule('kairos-dimension-diagnostics-us', '20 23 * * 1-5',
  $$select kairos_call_agent('/api/agents/dimension-diagnostics?market=us', '{}'::jsonb, 'POST', 60000)$$);
select cron.schedule('kairos-dimension-diagnostics-india', '25 23 * * 1-5',
  $$select kairos_call_agent('/api/agents/dimension-diagnostics?market=india', '{}'::jsonb, 'POST', 60000)$$);
