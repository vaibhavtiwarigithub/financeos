-- Nightly evaluation cells for the India LLM event score (measure-only). One row per series per horizon per batch.
-- Series: event:score, council:median_paired, deterministic:analyst_score_paired, event:partial_vs_composite_council,
-- corr:event_vs_council, corr:event_vs_composite, all on the same paired sample. Nothing in scoring reads this table.

create table if not exists public.llm_event_ic_runs (
  id bigint generated always as identity primary key,
  evaluation_batch_id uuid not null,
  evaluated_at timestamptz not null default now(),
  horizon_days int not null,
  series_key text not null,
  paired_observations int not null,
  observation_count int not null,
  qualifying_sessions int not null,
  independent_windows numeric not null,
  mean_session_rank_ic numeric,
  sd_session_rank_ic numeric,
  t_stat numeric,
  classification text not null check (classification in ('insufficient_evidence', 'measured_descriptive')),
  reason text not null
);
create index if not exists llm_event_ic_runs_batch_idx on public.llm_event_ic_runs (evaluated_at desc, horizon_days, series_key);

alter table public.llm_event_ic_runs enable row level security;
revoke all on public.llm_event_ic_runs from anon, authenticated;

drop trigger if exists llm_event_ic_runs_no_change on public.llm_event_ic_runs;
create trigger llm_event_ic_runs_no_change before update or delete on public.llm_event_ic_runs
  for each row execute function public.llm_event_append_only();

-- 14:30 UTC daily, after the 13:40 UTC extraction run.
select cron.schedule('kairos-llm-events-eval', '30 14 * * *',
  $$select public.kairos_call_agent('/api/agents/llm-events/evaluate', '{}'::jsonb, 'POST', 120000)$$);
