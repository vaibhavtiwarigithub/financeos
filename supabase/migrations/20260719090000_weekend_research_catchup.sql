-- Weekend Research Catch-up
--
-- Weekend scores are useful for consuming otherwise-idle provider quota, but
-- are never executable. A weekday/session run must write a fresh validated row.

alter table public.agent_signals
  add column if not exists session_validated boolean not null default true,
  add column if not exists as_of_session date,
  add column if not exists staged_at timestamptz;

alter table public.agent_runs
  add column if not exists workload_metrics jsonb;

alter table public.agent_signals
  drop constraint if exists agent_signals_weekend_stage_unvalidated;
alter table public.agent_signals
  add constraint agent_signals_weekend_stage_unvalidated
  check (status <> 'weekend_staged' or session_validated = false);

create unique index if not exists agent_signals_one_weekend_stage_per_symbol
  on public.agent_signals (market, symbol)
  where status = 'weekend_staged';

comment on column public.agent_signals.session_validated is
  'Positive money-path eligibility proof. False weekend scores are informational until a fresh market-session research pass writes a new validated row.';
comment on column public.agent_signals.as_of_session is
  'Market-local completed session whose observable data underlies this signal.';
comment on column public.agent_signals.staged_at is
  'When a non-executable weekend catch-up result was staged.';
comment on column public.agent_runs.workload_metrics is
  'Structured per-run queue/capacity telemetry; never used for scoring or execution.';

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('kairos-weekend-research-us','kairos-weekend-research-india')
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

-- Saturday + Sunday only. These run after the existing daily prewarm windows.
-- The route itself rejects weekday use and never chains a trader.
select cron.schedule(
  'kairos-weekend-research-india',
  '10 5 * * 0,6',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=india&mode=weekend_catchup', '{}'::jsonb, 'POST', 160000)$$
);

select cron.schedule(
  'kairos-weekend-research-us',
  '10 15 * * 0,6',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&mode=weekend_catchup', '{}'::jsonb, 'POST', 160000)$$
);
