-- Alpha Diagnostic Lab reuses the existing experiment registry rather than
-- creating a parallel one, so a diagnostic run inherits the append-only guard
-- (backtest_experiments_no_core_mutation), the service-only grants and the RLS
-- policy that already govern experiment lineage.
--
-- Only the experiment_type allowlist is widened. No column, trigger, grant or
-- policy is altered, and no browser write path is introduced.
--
-- APPLIED + VERIFIED 2026-08-27 against dionkikgdmlaotvtbnfr.

ALTER TABLE public.backtest_experiments
  DROP CONSTRAINT IF EXISTS backtest_experiments_experiment_type_check;

ALTER TABLE public.backtest_experiments
  ADD CONSTRAINT backtest_experiments_experiment_type_check
  CHECK (experiment_type = ANY (ARRAY[
    'ic_segment', 'parameter_sweep', 'regime_test', 'oos_ic', 'historical_replay',
    'alpha_diagnostic'
  ]));

COMMENT ON COLUMN public.backtest_experiments.experiment_type IS
  'Experiment family. alpha_diagnostic rows are READ-ONLY portfolio diagnostics (features/alpha-diagnostic-lab): they have no write path to any money-path table and their strongest verdict is owner_review, never promotion.';
