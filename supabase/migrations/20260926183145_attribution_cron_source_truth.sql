-- Distinguish service-secret authentication from proof that pg_cron was the
-- caller. The active cron schedule is verified separately in cron.job.
alter table public.international_allocation_replay_runs
  drop constraint if exists international_allocation_replay_runs_trigger_source_check;
alter table public.international_allocation_replay_runs
  add constraint international_allocation_replay_runs_trigger_source_check
  check (trigger_source in ('scheduled', 'cron_authenticated', 'owner_manual', 'manual_legacy'));
