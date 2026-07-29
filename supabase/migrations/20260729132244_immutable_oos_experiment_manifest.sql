-- Immutable OOS experiment identity.
--
-- An OOS result is not admissible unless its edge, formula, horizon, trial
-- family, universe policy, cutoff, code version, and validation plan were
-- committed before the first provider call. Completion fields are write-once.

alter table public.backtest_experiments
  drop constraint if exists backtest_experiments_experiment_type_check;

alter table public.backtest_experiments
  add constraint backtest_experiments_experiment_type_check
    check (experiment_type in ('ic_segment', 'parameter_sweep', 'regime_test', 'oos_ic'));

alter table public.backtest_experiments
  add column if not exists edge_id text references public.edge_catalog(edge_id),
  add column if not exists formula_version text,
  add column if not exists horizon_sessions int,
  add column if not exists validation_mode text,
  add column if not exists trial_family_id text,
  add column if not exists trials_considered int,
  add column if not exists universe_policy_version text,
  add column if not exists data_cutoff date,
  add column if not exists code_version text,
  add column if not exists validation_spec jsonb,
  add column if not exists plan_fingerprint text,
  add column if not exists universe_fingerprint text,
  add column if not exists dataset_fingerprint text,
  add column if not exists run_fingerprint text;

alter table public.backtest_experiments
  add constraint backtest_experiments_oos_manifest_required
    check (
      experiment_type <> 'oos_ic'
      or (
        edge_id is not null
        and length(formula_version) > 0
        and horizon_sessions > 0
        and validation_mode in ('purged_temporal_oos', 'walk_forward')
        and length(trial_family_id) > 0
        and trials_considered between 1 and variant_budget
        and length(universe_policy_version) > 0
        and data_cutoff is not null
        and code_version ~ '^[0-9a-f]{7,40}$'
        and validation_spec is not null
        and jsonb_typeof(validation_spec) = 'object'
        and validation_spec->>'schemaVersion' = '1'
        and plan_fingerprint ~ '^[0-9a-f]{64}$'
        and variants is not null
        and jsonb_typeof(variants) = 'array'
        and variants_proposed = jsonb_array_length(variants)
        and variants_proposed = trials_considered
      )
    ),
  add constraint backtest_experiments_completion_fingerprints
    check (
      (universe_fingerprint is null or universe_fingerprint ~ '^[0-9a-f]{64}$')
      and (dataset_fingerprint is null or dataset_fingerprint ~ '^[0-9a-f]{64}$')
      and (run_fingerprint is null or run_fingerprint ~ '^[0-9a-f]{64}$')
    );

create unique index if not exists backtest_experiments_plan_fingerprint_uidx
  on public.backtest_experiments (plan_fingerprint)
  where plan_fingerprint is not null;

create or replace function public.backtest_experiments_guard_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_mutable text[] := array[
    'started_at', 'completed_at', 'variants_run', 'result_summary', 'policy_id',
    'universe_fingerprint', 'dataset_fingerprint', 'run_fingerprint'
  ];
begin
  if (to_jsonb(old) - v_mutable) is distinct from (to_jsonb(new) - v_mutable) then
    raise exception 'backtest_experiments: predeclared plan fields are immutable after insert';
  end if;

  if old.started_at is not null and new.started_at is distinct from old.started_at then
    raise exception 'backtest_experiments: started_at is write-once';
  end if;
  if old.completed_at is not null and new.completed_at is distinct from old.completed_at then
    raise exception 'backtest_experiments: completed_at is write-once';
  end if;
  if old.variants_run is not null and new.variants_run is distinct from old.variants_run then
    raise exception 'backtest_experiments: variants_run is write-once';
  end if;
  if old.result_summary is not null and new.result_summary is distinct from old.result_summary then
    raise exception 'backtest_experiments: result_summary is write-once';
  end if;
  if old.policy_id is not null and new.policy_id is distinct from old.policy_id then
    raise exception 'backtest_experiments: policy_id is write-once';
  end if;
  if old.universe_fingerprint is not null
     and new.universe_fingerprint is distinct from old.universe_fingerprint then
    raise exception 'backtest_experiments: universe_fingerprint is write-once';
  end if;
  if old.dataset_fingerprint is not null
     and new.dataset_fingerprint is distinct from old.dataset_fingerprint then
    raise exception 'backtest_experiments: dataset_fingerprint is write-once';
  end if;
  if old.run_fingerprint is not null
     and new.run_fingerprint is distinct from old.run_fingerprint then
    raise exception 'backtest_experiments: run_fingerprint is write-once';
  end if;
  return new;
end;
$$;

revoke all on table public.backtest_experiments from anon, authenticated;
grant select, insert, update on table public.backtest_experiments to service_role;
