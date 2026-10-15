-- Persist the paired candidate-minus-baseline portfolio-bucket spread statistic.
-- Additive/idempotent; existing rows remain NULL because this metric is not
-- reconstructible from their aggregate-only persisted fields.
alter table public.score_variant_eval_runs
  add column if not exists paired_spread_delta numeric,
  add column if not exists paired_spread_delta_t numeric;
