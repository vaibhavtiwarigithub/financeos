-- Per-model reasoning controls for the API-backed council. Effort is captured
-- in each immutable run.config_snapshot so later comparisons remain reproducible.
alter table public.llm_council_config
  add column if not exists participant_efforts jsonb not null default '{}'::jsonb,
  add column if not exists orchestrator_effort text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'llm_council_participant_efforts_object'
      and conrelid = 'public.llm_council_config'::regclass
  ) then
    alter table public.llm_council_config
      add constraint llm_council_participant_efforts_object
      check (jsonb_typeof(participant_efforts) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'llm_council_orchestrator_effort_allowed'
      and conrelid = 'public.llm_council_config'::regclass
  ) then
    alter table public.llm_council_config
      add constraint llm_council_orchestrator_effort_allowed
      check (orchestrator_effort is null or orchestrator_effort in ('none','low','medium','high','xhigh','max'));
  end if;
end $$;
