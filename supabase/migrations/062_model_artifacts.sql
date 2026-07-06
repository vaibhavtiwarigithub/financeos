-- Phase 2 learning-core: fitted model artifacts (calibrated P(win) logistic
-- coefficients today; a home for future fitted models). One row per
-- market+kind, refit periodically as the ledger grows.

create table if not exists model_artifacts (
  id            bigserial primary key,
  market        text not null default 'us',
  kind          text not null,              -- 'pwin_logistic' today
  coefficients  jsonb not null,              -- {intercept, fundamental, technical, sentiment, macro, insider, means:{}, stdevs:{}}
  calibration   jsonb,                       -- decile predicted-vs-realized table
  n_observations int,
  fitted_at     timestamptz not null default now(),
  dataset_hash  text,
  unique (market, kind)
);

alter table model_artifacts disable row level security;
