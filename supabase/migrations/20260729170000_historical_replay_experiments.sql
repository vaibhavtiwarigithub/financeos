-- Local bulk-evidence replay plans reuse the immutable experiment lineage.
-- Raw evidence stays outside Supabase; only plan/result fingerprints and a
-- bounded structured summary are persisted.

alter table public.backtest_experiments
  drop constraint if exists backtest_experiments_experiment_type_check;

alter table public.backtest_experiments
  add constraint backtest_experiments_experiment_type_check
    check (
      experiment_type in (
        'ic_segment',
        'parameter_sweep',
        'regime_test',
        'oos_ic',
        'historical_replay'
      )
    );

alter table public.backtest_experiments
  add constraint backtest_experiments_historical_replay_manifest_required
    check (
      experiment_type <> 'historical_replay'
      or (
        edge_id is not null
        and length(formula_version) > 0
        and horizon_sessions > 0
        and validation_mode = 'purged_temporal_oos'
        and length(trial_family_id) > 0
        and trials_considered between 1 and variant_budget
        and length(universe_policy_version) > 0
        and data_cutoff is not null
        and code_version ~ '^[0-9a-f]{7,40}$'
        and validation_spec is not null
        and jsonb_typeof(validation_spec) = 'object'
        and validation_spec->>'schemaVersion' = 'kairos.historical-replay.v1'
        and validation_spec->>'evidenceClass' = 'diagnostic'
        and plan_fingerprint ~ '^[0-9a-f]{64}$'
        and variants is not null
        and jsonb_typeof(variants) = 'array'
        and variants_proposed = jsonb_array_length(variants)
        and variants_proposed = trials_considered
      )
    );

-- Preserve the existing deny-by-default contract after the additive type change.
alter table public.backtest_experiments enable row level security;
revoke all on table public.backtest_experiments from anon, authenticated;
grant select, insert, update on table public.backtest_experiments to service_role;
