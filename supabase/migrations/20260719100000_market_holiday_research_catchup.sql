-- Market-closed-day Research Catch-up
--
-- Run the inert catch-up trigger every day. The route's explicit, versioned,
-- per-market equity calendar decides whether the day is a weekend/full holiday
-- and refuses normal trading days, special sessions, and unsupported years.

comment on column public.agent_signals.session_validated is
  'Positive money-path eligibility proof. False closed-day scores are informational until a fresh market-session research pass writes a new validated row.';

comment on column public.agent_signals.staged_at is
  'When a non-executable market-closed-day catch-up result was staged.';

do $$
declare j record;
begin
  for j in
    select jobid
    from cron.job
    where jobname in (
      'kairos-weekend-research-us',
      'kairos-weekend-research-india',
      'kairos-closed-day-research-us',
      'kairos-closed-day-research-india'
    )
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule(
  'kairos-closed-day-research-india',
  '10 5 * * *',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=india&mode=closed_day_catchup', '{}'::jsonb, 'POST', 160000)$$
);

select cron.schedule(
  'kairos-closed-day-research-us',
  '10 15 * * *',
  $$select public.kairos_call_agent('/api/agents/research/cron?market=us&mode=closed_day_catchup', '{}'::jsonb, 'POST', 160000)$$
);
