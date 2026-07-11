-- 159: Remove the committed cron credential from scheduler commands, protect
-- stale-check with the shared Vault-backed caller, and make learner run history
-- market-specific. No append-only trading ledger is changed.

-- US and India learner runs currently collide on learner_runs.run_date. Preserve
-- existing history as US, then enforce one row per market/day.
alter table public.learner_runs
  add column if not exists market text not null default 'us'
  check (market in ('us', 'india'));

alter table public.learner_runs
  drop constraint if exists learner_runs_run_date_key;

create unique index if not exists learner_runs_run_date_market_uidx
  on public.learner_runs (run_date, market);

-- Replace raw pg_net commands (one of which contained a committed bearer token)
-- with kairos_call_agent(), which reads the credential from Supabase Vault and
-- never stores it in cron.job.command.
do $$
begin
  begin perform cron.unschedule('kairos-live-exit-monitor'); exception when others then null; end;
  begin perform cron.unschedule('kairos-stale-check'); exception when others then null; end;
  begin perform cron.unschedule('kairos-learner'); exception when others then null; end;
  begin perform cron.unschedule('kairos-learner-india'); exception when others then null; end;
end $$;

select cron.schedule('kairos-live-exit-monitor', '0 3-20 * * 1-5',
  $$select public.kairos_call_agent('/api/agents/live-exit-monitor/cron', '{}'::jsonb, 'POST', 25000)$$);

select cron.schedule('kairos-stale-check', '0 */4 * * *',
  $$select public.kairos_call_agent('/api/alerts/stale-check', '{}'::jsonb, 'POST', 30000)$$);

select cron.schedule('kairos-learner', '0 21 * * 5',
  $$select public.kairos_call_agent('/api/agents/learner', '{"market":"us"}'::jsonb, 'POST', 290000)$$);

select cron.schedule('kairos-learner-india', '30 20 * * 5',
  $$select public.kairos_call_agent('/api/agents/learner', '{"market":"india"}'::jsonb, 'POST', 290000)$$);
