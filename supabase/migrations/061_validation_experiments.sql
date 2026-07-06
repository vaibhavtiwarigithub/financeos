-- Phase 2 learning-core: Validation Engine experiment ledger. A challenger
-- must have a PASSED row here before promote_champion will accept it
-- (fail-closed gate — see app/api/strategies/versions/route.ts).

create table if not exists validation_experiments (
  id               bigserial primary key,
  created_at       timestamptz default now(),
  market           text not null default 'us',
  challenger_id    bigint not null,
  champion_id      bigint,
  horizon_days     int not null,
  dataset_hash     text not null,
  n_observations   int not null,
  n_effective      numeric,
  objective        text not null default 'benchmark_neutral_log_growth',
  challenger_score numeric,
  champion_score   numeric,
  paired_diff_mean numeric,
  paired_diff_ci_low numeric,
  paired_diff_ci_high numeric,
  p_improvement    numeric,
  folds            jsonb,
  passed           boolean not null default false,
  fail_reason      text,
  config           jsonb
);

alter table validation_experiments disable row level security;
create index if not exists vexp_challenger_idx on validation_experiments(challenger_id, created_at desc);

alter table strategy_versions add column if not exists validation_experiment_id bigint;
