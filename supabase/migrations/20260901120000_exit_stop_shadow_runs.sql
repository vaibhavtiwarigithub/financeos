-- ATR-scaled exit stop, shadow arm. MEASURE-ONLY.
--
-- Records one paired comparison per (as_of_date, market, horizon): the LIVE
-- geometry (7.5% stop / 19.2% target) against a candidate that changes ONLY the
-- stop (2.8 ATR / 19.2% target). Target and time stop are held identical so any
-- difference is attributable to the stop alone.
--
-- Nothing in the money path reads this table. See
-- features/atr-exit-stop/FEATURE_ARCHITECTURE.md.
--
-- APPLIED to production 2026-09-01 and verified via information_schema.
create table if not exists exit_stop_shadow_runs (
  id bigserial primary key,
  as_of_date date not null,
  market text not null check (market = any (array['us','india'])),
  horizon_days integer not null check (horizon_days = any (array[2,5,10,20])),

  -- Cohort provenance. n_dates is the sample size that matters; n_rows is not.
  n_rows integer not null check (n_rows >= 0),
  n_dates integer not null check (n_dates >= 0),
  n_symbols integer not null check (n_symbols >= 0),
  effective_observations numeric not null,
  atr_coverage numeric,

  -- Paired outcome counts.
  baseline_stops integer not null,
  candidate_stops integer not null,
  baseline_timeouts integer not null,
  candidate_timeouts integer not null,
  baseline_targets integer not null,
  candidate_targets integer not null,
  pairs_dropped integer not null,
  ambiguous_share numeric,

  -- The statistic: mean PAIRED difference, date-clustered.
  baseline_mean_return numeric,
  candidate_mean_return numeric,
  mean_paired_diff numeric,
  paired_diff_t numeric,
  -- Tail behaviour. A wider stop can raise the mean while worsening the worst
  -- case, so the worst single outcome is recorded, not just the average.
  candidate_worst_return numeric,
  baseline_worst_return numeric,

  -- Predeclared multiplicity control for the 14-arm grid this hypothesis was
  -- selected from. Stored per row so a later reader cannot mistake the nominal
  -- p-value for the adjusted threshold.
  trials_considered integer not null default 14,
  sidak_alpha numeric not null,

  status text not null check (status = any (array['insufficient_evidence','measured'])),
  reason text not null,
  code_version text,
  created_at timestamptz not null default now(),

  unique (as_of_date, market, horizon_days)
);

create index if not exists exit_stop_shadow_runs_lookup_idx
  on exit_stop_shadow_runs (market, horizon_days, as_of_date desc);

comment on table exit_stop_shadow_runs is
  'Measure-only shadow: ATR stop vs live fixed stop, target and time stop held identical. No money path reads this.';
comment on column exit_stop_shadow_runs.mean_paired_diff is
  'Mean of per-date (candidate - baseline) return. Positive favours the ATR stop. Not significant unless paired_diff_t clears the Sidak-adjusted threshold AND effective_observations >= 12.';
