-- A local historical experiment may remain visibly incomplete after an
-- interrupted process, but a completed row must be fully bound and auditable.

alter table public.backtest_experiments
  add constraint backtest_experiments_historical_replay_completion_required
    check (
      experiment_type <> 'historical_replay'
      or completed_at is null
      or (
        variants_run = trials_considered
        and result_summary is not null
        and jsonb_typeof(result_summary) = 'object'
        and result_summary->>'schemaVersion' = 'kairos.historical-replay.result.v1'
        and result_summary->>'evidenceClass' = 'diagnostic'
        and universe_fingerprint ~ '^[0-9a-f]{64}$'
        and dataset_fingerprint ~ '^[0-9a-f]{64}$'
        and run_fingerprint ~ '^[0-9a-f]{64}$'
      )
    );
